/**
 * STC-MOD - storage quota tests: usage accounting (async walk, per-user cache, single-flight,
 * pending bytes, recounts, unknown on errors), request classification against the official
 * routers, shrinking-save detection and the enforcement middleware (temp data root, no server).
 * Run: node src/stc-mod/tests/storage-quota.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The official modules read config.yaml at import time and STC-MOD reads <cwd>/config.yaml:
// point both at a temp config (quota on, 1 MiB default limit) and a temp data root.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-storage-quota-'));
const configPath = path.join(tmpDir, 'config.yaml');
fs.writeFileSync(configPath, 'skipContentCheck: true\nuserStorage:\n  enabled: true\n  defaultLimitMiB: 1\n  dailyCheckInMiB: 0\n');
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(dataRoot);
globalThis.DATA_ROOT = dataRoot;
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { setConfigFilePath } = await import('../../util.js');
setConfigFilePath(configPath);
const quota = await import('../services/storage-quota.js');
const enforce = await import('../middleware/storage-enforce.js');

const {
    buildStorageInfo,
    createLimiter,
    createUsageTracker,
    getUserStorageInfoAsync,
    getUserUsage,
    getUsersUsage,
    invalidateUserUsage,
    measureDirectory,
    recordUserWrite,
} = quota;
const {
    BLOCKED_ROUTES,
    checkShrinkingSave,
    classifyRequest,
    createStorageEnforceMiddleware,
    estimateRequestBytes,
    resolveShrinkTarget,
} = enforce;

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MiB = 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Deferred promise.
 * @template T
 */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Fs error with a code.
 * @param {string} code
 */
function fsError(code) {
    const error = new Error(`${code}: simulated`);
    // @ts-ignore
    error.code = code;
    return error;
}

/**
 * Write a file of `size` bytes (parents created).
 * @param {string} file
 * @param {number|string} content Size in bytes or the content
 */
function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'number' ? Buffer.alloc(content, 1) : content);
}

// ---------------------------------------------------------------------------
// measureDirectory (the walk)
// ---------------------------------------------------------------------------

test('walk: sums regular files per top-level entry, skips symlinks', async () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'walk-'));
    writeFile(path.join(root, 'settings.json'), 10);
    writeFile(path.join(root, 'chats', 'Alice', 'a.jsonl'), 100);
    writeFile(path.join(root, 'chats', 'Bob', 'b.jsonl'), 50);
    writeFile(path.join(root, 'backups', 'chat_x.jsonl'), 7);
    fs.mkdirSync(path.join(root, 'empty'));
    fs.symlinkSync(path.join(root, 'chats'), path.join(root, 'link-to-chats'));
    fs.symlinkSync(path.join(root, 'settings.json'), path.join(root, 'link-to-file'));
    const result = await measureDirectory(root);
    assert.equal(result.bytes, 167);
    assert.deepEqual(result.categories, { '': 10, chats: 150, backups: 7 });
});

test('walk: a missing root rejects (never 0)', async () => {
    await assert.rejects(measureDirectory(path.join(tmpDir, 'does-not-exist')), { code: 'ENOENT' });
});

test('walk: EIO / ENOTCONN / EACCES / EISDIR anywhere rejects; ENOENT of an entry removed while walking is skipped', async () => {
    const root = '/virtual';
    const dirent = (name, dir) => ({ name, isDirectory: () => dir, isFile: () => !dir });
    const tree = {
        '/virtual': [dirent('chats', true), dirent('a.txt', false), dirent('gone.txt', false), dirent('gone-dir', true)],
        '/virtual/chats': [dirent('c.jsonl', false)],
    };
    const makeFs = ({ readdirFail = {}, statFail = {} } = {}) => ({
        readdir: async (dir) => {
            if (readdirFail[dir]) throw fsError(readdirFail[dir]);
            if (dir === '/virtual/gone-dir') throw fsError('ENOENT');
            return tree[dir];
        },
        stat: async (file) => {
            if (statFail[file]) throw fsError(statFail[file]);
            if (file === '/virtual/gone.txt') throw fsError('ENOENT');
            return { size: 5 };
        },
    });
    const limit = createLimiter(2);
    const ok = await measureDirectory(root, { fsp: makeFs(), limit });
    assert.equal(ok.bytes, 10);
    for (const code of ['EIO', 'ENOTCONN', 'EACCES', 'EPERM', 'ETIMEDOUT']) {
        await assert.rejects(measureDirectory(root, { fsp: makeFs({ readdirFail: { '/virtual/chats': code } }), limit }), { code });
        await assert.rejects(measureDirectory(root, { fsp: makeFs({ statFail: { '/virtual/chats/c.jsonl': code } }), limit }), { code });
        await assert.rejects(measureDirectory(root, { fsp: makeFs({ readdirFail: { '/virtual': code } }), limit }), { code });
    }
    await assert.rejects(measureDirectory(root, { fsp: makeFs({ readdirFail: { '/virtual': 'ENOENT' } }), limit }), { code: 'ENOENT' });
});

test('limiter: FIFO with O(1) dequeue (time grows linearly with the queue length)', async () => {
    const limit = createLimiter(4);
    const order = [];
    await Promise.all(Array.from({ length: 10 }, (_, i) => limit(async () => { order.push(i); })));
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const timeQueue = async (n) => {
        let best = Infinity;
        for (let round = 0; round < 2; round++) {
            let done = 0;
            const started = performance.now();
            await Promise.all(Array.from({ length: n }, () => limit(async () => { done++; })));
            assert.equal(done, n);
            best = Math.min(best, performance.now() - started);
        }
        return best;
    };
    const small = await timeQueue(25_000);
    const large = await timeQueue(100_000);
    // Linear: ~4x; Array#shift (quadratic) was ~15x and more
    assert.ok(large < 10 * Math.max(small, 20), `25k: ${small.toFixed(0)} ms, 100k: ${large.toFixed(0)} ms`);
    await assert.rejects(limit(async () => { throw fsError('EIO'); }), { code: 'EIO' });
    assert.equal(await limit(async () => 7), 7, 'a rejection does not stall the queue');
});

test('walk: at most `width` operations in flight and no per-file task queued up front (large directory)', async () => {
    const entries = Array.from({ length: 20_000 }, (_, i) => ({ name: `f${i}`, isDirectory: () => false, isFile: () => true }));
    let queuedPeak = 0;
    let queuedNow = 0;
    const fsp = {
        readdir: async () => entries,
        stat: async () => ({ size: 2 }),
    };
    // A wide limiter: the walk itself must keep the number of queued / running operations small
    const inner = createLimiter(64);
    const limit = (fn) => {
        queuedNow++;
        queuedPeak = Math.max(queuedPeak, queuedNow);
        return inner(fn).finally(() => { queuedNow--; });
    };
    const result = await measureDirectory('/big', { fsp, limit, width: 3 });
    assert.equal(result.bytes, 40_000);
    assert.ok(queuedPeak <= 3, `peak ${queuedPeak}`);
    assert.ok(quota.USAGE_FS_CONCURRENCY >= 1 && quota.USAGE_FS_CONCURRENCY < (Number(process.env.UV_THREADPOOL_SIZE) || 4), 'walks leave a threadpool thread free');
});

test('walk: an aborted walk stops before its next operation and rejects', async () => {
    const controller = new AbortController();
    let stats = 0;
    const entries = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}`, isDirectory: () => false, isFile: () => true }));
    const fsp = {
        readdir: async () => entries,
        stat: async () => {
            stats++;
            if (stats === 5) controller.abort();
            return { size: 1 };
        },
    };
    await assert.rejects(measureDirectory('/x', { fsp, limit: createLimiter(1), width: 1, signal: controller.signal }));
    assert.ok(stats < 10, `${stats} stats`);
});

test('walk: filesystem operations are bounded by the limiter', async () => {
    let active = 0;
    let peak = 0;
    const entries = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, isDirectory: () => false, isFile: () => true }));
    const fsp = {
        readdir: async () => entries,
        stat: async () => {
            active++;
            peak = Math.max(peak, active);
            await sleep(2);
            active--;
            return { size: 1 };
        },
    };
    const result = await measureDirectory('/x', { fsp, limit: createLimiter(3) });
    assert.equal(result.bytes, 40);
    assert.ok(peak <= 3, `peak ${peak}`);
});

// ---------------------------------------------------------------------------
// Usage tracker (cache, single-flight, pending, recounts, unknown)
// ---------------------------------------------------------------------------

/**
 * Tracker with a scripted walk. `script` answers each call: a number, an Error, or a deferred.
 * @param {object} [opts]
 */
function makeTracker(opts = {}) {
    const calls = [];
    const results = [];
    let clock = 1_000_000;
    const tracker = createUsageTracker({
        walk: (handle) => {
            calls.push(handle);
            const next = results.length ? results.shift() : 100;
            if (next instanceof Error) return Promise.reject(next);
            if (next && typeof next.then === 'function') return next;
            if (next && typeof next.promise?.then === 'function') return next.promise;
            return Promise.resolve({ bytes: next, categories: { chats: next } });
        },
        now: () => clock,
        // Timers kept referenced so a test waiting only on them keeps the event loop alive
        setTimer: (fn, ms) => ({ id: setTimeout(fn, ms) }),
        clearTimer: timer => clearTimeout(timer.id),
        writeRecountMs: 40,
        freeRecountMs: 5,
        errorRetryMs: 30_000,
        ...opts,
    });
    return {
        tracker,
        calls,
        results,
        advance: (ms) => { clock += ms; },
    };
}

test('tracker: single-flight per user and fresh values are served from the cache', async () => {
    const { tracker, calls, results, advance } = makeTracker();
    const d = deferred();
    results.push(d);
    const a = tracker.get('u1');
    const b = tracker.get('u1');
    assert.equal(tracker.peek('u1').computing, true);
    d.resolve({ bytes: 500, categories: {} });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(calls.length, 1);
    assert.equal(ra.bytes, 500);
    assert.equal(rb.bytes, 500);
    assert.equal(ra.fresh, true);
    assert.equal(ra.computing, false, 'a finished count is not reported as running');
    assert.equal(buildStorageInfo('x', ra).pending, false);

    advance(9 * 60 * 1000);
    assert.equal((await tracker.get('u1')).bytes, 500);
    assert.equal(calls.length, 1, 'fresh value reused');

    advance(2 * 60 * 1000); // > 10 min
    results.push(700);
    assert.equal((await tracker.get('u1')).bytes, 700);
    assert.equal(calls.length, 2, 'stale value recounted');
});

test('tracker: a walk error is unknown (null), never 0, with a retry backoff', async () => {
    const { tracker, calls, results, advance } = makeTracker();
    results.push(300);
    assert.equal((await tracker.get('u1')).bytes, 300);
    advance(11 * 60 * 1000);
    results.push(fsError('EIO'));
    const failed = await tracker.get('u1');
    assert.equal(failed.bytes, null);
    assert.equal(failed.unknown, true);
    assert.equal(failed.error, 'EIO');
    assert.equal(calls.length, 2);

    // Within the backoff: no new walk, still unknown (not the stale 300, not 0)
    advance(10_000);
    const again = await tracker.get('u1');
    assert.equal(again.bytes, null);
    assert.equal(calls.length, 2);

    advance(25_000);
    results.push(400);
    assert.equal((await tracker.get('u1')).bytes, 400);
    assert.equal(calls.length, 3);

    // An invalid walk result is unknown too
    const t2 = makeTracker();
    t2.results.push({ then: (res) => res({ bytes: -1 }) });
    assert.equal((await t2.tracker.get('x')).bytes, null);
});

test('tracker: a walk that hangs (e.g. a stuck FUSE mount) is unknown (ETIMEDOUT) after the timeout but keeps its single-flight slot; a late result is cached', async () => {
    const { tracker, calls, results, advance } = makeTracker({ walkTimeoutMs: 20 });
    const hung = deferred();
    results.push(hung);
    const snap = await tracker.get('u1');
    assert.equal(snap.bytes, null);
    assert.equal(snap.error, 'ETIMEDOUT');
    assert.equal(snap.computing, true, 'the count still runs');
    // Past the error backoff: no second walk of the same tree while the first one runs, and no wait
    advance(60_000);
    const started = Date.now();
    const again = await tracker.get('u1', { waitMs: 5000 });
    assert.ok(Date.now() - started < 1000, 'an overdue count is not waited for');
    assert.equal(again.error, 'ETIMEDOUT');
    assert.equal(calls.length, 1);
    tracker.refresh('u1');
    assert.equal(calls.length, 1, 'refresh joins the running count');
    // The late result is not discarded
    hung.resolve({ bytes: 64, categories: {} });
    await sleep(5);
    const late = tracker.peek('u1');
    assert.equal(late.bytes, 64);
    assert.equal(late.error, null);
    assert.equal(late.computing, false);
    assert.equal((await tracker.get('u1')).bytes, 64, 'fresh: no new walk');
    assert.equal(calls.length, 1);
});

test('tracker: overlapping requests during a slow walk never start a second walk of the same user (timeout, retry pause)', async () => {
    let started = 0;
    let running = 0;
    let peak = 0;
    const tracker = createUsageTracker({
        walk: async () => {
            started++;
            running++;
            peak = Math.max(peak, running);
            await sleep(150);
            running--;
            return { bytes: 1, categories: {} };
        },
        walkTimeoutMs: 40,
        errorRetryMs: 10,
    });
    for (let i = 0; i < 12; i++) {
        tracker.get('u', { waitMs: 5 });
        await sleep(15);
    }
    await sleep(160);
    assert.equal(started, 1);
    assert.equal(peak, 1);
    assert.equal(tracker.peek('u').bytes, 1, 'the slow count is cached, the quota is enforced');
});

test('tracker: an overdue recount keeps the stale value in use (not unknown) and callers stop waiting', async () => {
    const { tracker, calls, results, advance } = makeTracker({ walkTimeoutMs: 30 });
    results.push(700);
    assert.equal((await tracker.get('u1')).bytes, 700);
    advance(11 * 60 * 1000);
    const slow = deferred();
    results.push(slow);
    const snap = await tracker.get('u1');
    assert.equal(snap.bytes, 700);
    assert.equal(snap.fresh, false);
    assert.equal(snap.computing, true);
    assert.equal(calls.length, 2);
    slow.resolve({ bytes: 900, categories: {} });
    await sleep(5);
    assert.equal(tracker.peek('u1').bytes, 900);
});

test('tracker: invalidate aborts the running walk (it stops before its next filesystem operation)', async () => {
    let signal;
    const gate = deferred();
    const tracker = createUsageTracker({
        walk: async (handle, opts) => {
            signal = opts.signal;
            await gate.promise;
            if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
            return { bytes: 5, categories: {} };
        },
        walkTimeoutMs: Infinity,
    });
    const running = tracker.refresh('u1');
    tracker.invalidate('u1');
    assert.equal(signal.aborted, true);
    gate.resolve();
    await running;
    assert.equal(tracker.peek('u1').bytes, null, 'the discarded count leaves nothing behind');
    assert.equal(tracker.peek('u1').error, null);
});

test('tracker: bounded wait returns the stale / unknown value, the count continues in the background', async () => {
    const { tracker, results, advance } = makeTracker();
    const first = deferred();
    results.push(first);
    const snap = await tracker.get('u1', { waitMs: 10 });
    assert.equal(snap.unknown, true);
    assert.equal(snap.computing, true);
    first.resolve({ bytes: 42, categories: {} });
    await sleep(5);
    assert.equal(tracker.peek('u1').bytes, 42);

    advance(11 * 60 * 1000);
    const second = deferred();
    results.push(second);
    const stale = await tracker.get('u1', { waitMs: 10 });
    assert.equal(stale.bytes, 42, 'stale known value while recounting');
    assert.equal(stale.fresh, false);
    second.resolve({ bytes: 43, categories: {} });
    await sleep(5);
    assert.equal(tracker.peek('u1').bytes, 43);
});

test('tracker: pending bytes of writes and the recount after writes (not postponed by later writes)', async () => {
    const { tracker, calls, results } = makeTracker();
    results.push(1000);
    await tracker.get('u1');
    tracker.recordWrite('u1', 200);
    await sleep(20);
    tracker.recordWrite('u1', 50); // does not postpone the recount scheduled by the first write
    let snap = tracker.peek('u1');
    assert.equal(snap.bytes, 1000);
    assert.equal(snap.pendingBytes, 250);
    results.push(1180);
    await sleep(45);
    snap = tracker.peek('u1');
    assert.equal(calls.length, 2, 'recounted ~40 ms after the first write');
    assert.equal(snap.bytes, 1180);
    assert.equal(snap.pendingBytes, 0);
});

test('tracker: writes recorded while a walk runs stay pending', async () => {
    const { tracker, results } = makeTracker({ writeRecountMs: 60_000 });
    const d = deferred();
    results.push(d);
    const p = tracker.get('u1');
    tracker.recordWrite('u1', 77);
    d.resolve({ bytes: 10, categories: {} });
    const snap = await p;
    assert.equal(snap.bytes, 10);
    assert.equal(snap.pendingBytes, 77);
    tracker.invalidate('u1'); // clears the scheduled recount timer
});

test('tracker: deletions trigger a prompt recount only when a value is cached; a running count is followed by another', async () => {
    const { tracker, calls, results } = makeTracker();
    tracker.recordFree('nobody');
    await sleep(15);
    assert.equal(calls.length, 0, 'nothing cached: no walk');

    results.push(900);
    await tracker.get('u1');
    results.push(400);
    tracker.recordFree('u1');
    await sleep(20);
    assert.equal(calls.length, 2);
    assert.equal(tracker.peek('u1').bytes, 400);

    // A count running when the deletion's recount fires may have missed it: another one follows
    const slow = deferred();
    results.push(slow);
    tracker.refresh('u1');
    tracker.recordFree('u1');
    await sleep(15);
    assert.equal(calls.length, 3, 'waits for the running count');
    results.push(100);
    slow.resolve({ bytes: 350, categories: {} });
    await sleep(15);
    assert.equal(calls.length, 4);
    assert.equal(tracker.peek('u1').bytes, 100);
});

test('tracker: invalidate drops the value and discards a running count', async () => {
    const { tracker, calls, results } = makeTracker();
    results.push(5000);
    await tracker.get('u1');
    const d = deferred();
    results.push(d);
    const running = tracker.refresh('u1');
    tracker.invalidate('u1');
    d.resolve({ bytes: 9999, categories: {} });
    await running;
    assert.equal(tracker.peek('u1').bytes, null, 'result of the discarded count not cached');
    results.push(10);
    assert.equal((await tracker.get('u1')).bytes, 10);
    assert.equal(calls.length, 3);
});

test('tracker: getMany counts with bounded concurrency and returns partial results after the deadline', async () => {
    let active = 0;
    let peak = 0;
    const gates = new Map();
    const tracker = createUsageTracker({
        walk: async (handle) => {
            active++;
            peak = Math.max(peak, active);
            const gate = deferred();
            gates.set(handle, gate);
            await gate.promise;
            active--;
            return { bytes: handle.length, categories: {} };
        },
        setTimer: (fn, ms) => ({ id: setTimeout(fn, ms) }),
        clearTimer: timer => clearTimeout(timer.id),
        listConcurrency: 2,
    });
    const handles = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];
    const partial = await tracker.getMany(handles, { deadlineMs: 20 });
    assert.equal(peak, 2);
    assert.equal(partial.size, 5);
    for (const h of handles) {
        assert.equal(partial.get(h).bytes, null);
        assert.equal(partial.get(h).computing, true, `${h} queued or counting`);
    }
    // Release all gates as they open; the queue keeps going after the deadline
    for (let i = 0; i < 10 && gates.size < 5; i++) {
        for (const g of gates.values()) g.resolve();
        await sleep(5);
    }
    for (const g of gates.values()) g.resolve();
    await sleep(10);
    assert.equal(peak, 2);
    const full = await tracker.getMany(handles, { deadlineMs: 20 });
    assert.deepEqual(handles.map(h => full.get(h).bytes), [1, 2, 3, 4, 5]);
});

// ---------------------------------------------------------------------------
// Storage info
// ---------------------------------------------------------------------------

test('info: unknown usage is writable with null sizes; pending bytes count as used', () => {
    const unknown = buildStorageInfo('someone', { bytes: null, pendingBytes: 0, computing: true });
    assert.equal(unknown.enabled, true);
    assert.equal(unknown.canWrite, true);
    assert.equal(unknown.unknown, true);
    assert.equal(unknown.pending, true);
    assert.equal(unknown.usedMiB, null);
    assert.equal(unknown.percent, null);
    assert.equal(unknown.limitMiB, 1);

    const known = buildStorageInfo('someone', { bytes: 0.5 * MiB, pendingBytes: 0.6 * MiB, fresh: true, computing: false, computedAt: 1 });
    assert.equal(known.usedMiB, 1.1);
    assert.equal(known.canWrite, false);
    assert.equal(known.pending, true);
    assert.equal(known.pendingMiB, 0.6);
    assert.equal(known.percent, 110);
    assert.equal(known.remainingMiB, 0);
    for (const key of ['limitMiB', 'usedMiB', 'remainingMiB', 'percent', 'canWrite', 'lastCheckInDate', 'dailyCheckInMiB']) {
        assert.ok(key in known, key);
    }
});

test('info (real module): usage from the data root; a missing user directory is unknown, not 0', async () => {
    writeFile(path.join(dataRoot, 'big-user', 'chats', 'x', 'a.jsonl'), 2 * MiB);
    writeFile(path.join(dataRoot, 'small-user', 'chats', 'x', 'a.jsonl'), 1000);
    const big = await getUserStorageInfoAsync('big-user');
    assert.equal(big.usedMiB, 2);
    assert.equal(big.canWrite, false);
    const small = await getUserStorageInfoAsync('small-user');
    assert.equal(small.canWrite, true);
    const ghost = await getUserStorageInfoAsync('ghost-user');
    assert.equal(ghost.unknown, true);
    assert.equal(ghost.usedMiB, null);
    assert.equal(ghost.canWrite, true);

    recordUserWrite('small-user', 2 * MiB);
    const pending = await getUserStorageInfoAsync('small-user');
    assert.equal(pending.canWrite, false, 'pending bytes count until the recount');
    assert.equal(pending.pending, true);
    invalidateUserUsage('small-user');
    assert.equal((await getUserStorageInfoAsync('small-user')).canWrite, true);

    const many = await getUsersUsage(['big-user', 'small-user', 'ghost-user']);
    assert.equal(many.get('big-user').bytes, 2 * MiB);
    assert.equal(many.get('ghost-user').bytes, null);
    invalidateUserUsage('big-user');
    invalidateUserUsage('ghost-user');
    assert.equal((await getUserUsage('big-user', { maxAgeMs: 0 })).bytes, 2 * MiB);
});

test('info (real module): a lost data root mount (device changed) makes the usage unknown, not 0', async () => {
    const { initDataRootGuard } = await import('../services/json-store.js');
    writeFile(path.join(dataRoot, 'mount-user', 'chats', 'a.jsonl'), 3 * MiB);
    // Pretend the data root was a mount with device 4242 at startup: its real device differs now
    initDataRootGuard({ root: dataRoot, statSync: p => ({ dev: path.resolve(p) === path.resolve(dataRoot) ? 4242 : fs.statSync(p).dev }) });
    try {
        invalidateUserUsage('mount-user');
        const lost = await getUserUsage('mount-user', { maxAgeMs: 0 });
        assert.equal(lost.bytes, null);
        assert.equal(lost.error, 'STORE_UNAVAILABLE');
    } finally {
        initDataRootGuard({ root: dataRoot });
        invalidateUserUsage('mount-user');
    }
    assert.equal((await getUserUsage('mount-user', { maxAgeMs: 0 })).bytes, 3 * MiB);
});

// ---------------------------------------------------------------------------
// Classification (checked against the official routers)
// ---------------------------------------------------------------------------

/**
 * Expected class of every POST route of the official routers the quota touches.
 * A route added upstream fails the "every official route is classified" test until reviewed here.
 */
const EXPECTED = {
    '/api/files': {
        '/sanitize-filename': 'read', '/upload': 'write', '/delete': 'free', '/verify': 'read',
    },
    '/api/images': {
        '/upload': 'write', '/list/:folder?': 'read', '/folders': 'read', '/delete': 'free',
    },
    '/api/sprites': {
        '/delete': 'free', '/upload-zip': 'write', '/upload': 'write',
    },
    '/api/backgrounds': {
        '/all': 'read', '/folders': 'read', '/delete': 'free', '/rename': 'free', '/upload': 'write',
    },
    '/api/chats': {
        '/save': 'write', '/get': 'none', '/rename': 'free', '/delete': 'free', '/export': 'none',
        '/group/import': 'write', '/import': 'write', '/group/get': 'none', '/group/info': 'none',
        '/group/delete': 'free', '/group/save': 'write', '/search': 'none', '/recent': 'none',
    },
    '/api/characters': {
        '/create': 'write', '/rename': 'free', '/edit': 'write', '/edit-avatar': 'write',
        '/edit-attribute': 'write', '/merge-attributes': 'write', '/delete': 'free', '/all': 'none',
        '/get': 'none', '/chats': 'none', '/import': 'write', '/duplicate': 'write', '/export': 'none',
    },
    '/api/worldinfo': {
        '/list': 'none', '/get': 'none', '/delete': 'free', '/import': 'write', '/edit': 'write',
    },
    '/api/backups': {
        '/chat/get': 'none', '/chat/delete': 'free', '/chat/download': 'none',
    },
    '/api/avatars': {
        '/get': 'none', '/delete': 'free', '/upload': 'write',
    },
    '/api/groups': {
        '/all': 'none', '/create': 'write', '/edit': 'none', '/delete': 'free',
    },
    '/api/content': {
        '/importURL': 'write', '/importUUID': 'write',
    },
    '/api/assets': {
        '/get': 'none', '/download': 'write', '/delete': 'free', '/character': 'none',
    },
    '/api/extensions': {
        '/install': 'write', '/update': 'none', '/branches': 'none', '/switch': 'none', '/move': 'none',
        '/version': 'none', '/delete': 'free',
    },
};
const ROUTER_FILES = {
    '/api/files': 'files.js',
    '/api/images': 'images.js',
    '/api/sprites': 'sprites.js',
    '/api/backgrounds': 'backgrounds.js',
    '/api/chats': 'chats.js',
    '/api/characters': 'characters.js',
    '/api/worldinfo': 'worldinfo.js',
    '/api/backups': 'backups.js',
    '/api/avatars': 'avatars.js',
    '/api/groups': 'groups.js',
    '/api/content': 'content-manager.js',
    '/api/assets': 'assets.js',
    '/api/extensions': 'extensions.js',
};

test('classification: every POST route of the official routers matches the reviewed table', () => {
    const table = [];
    for (const [prefix, file] of Object.entries(ROUTER_FILES)) {
        const source = fs.readFileSync(path.join(REPO_SRC, 'endpoints', file), 'utf8');
        const routes = [...source.matchAll(/router\.post\(\s*'([^']+)'/g)].map(m => m[1]);
        assert.ok(routes.length > 0, `${file}: no routes found`);
        assert.deepEqual([...routes].sort(), Object.keys(EXPECTED[prefix]).sort(), `${file}: official POST routes changed, review the quota classification`);
        for (const route of routes) {
            const concrete = route.replace('/:folder?', '');
            const actual = classifyRequest('POST', prefix + concrete).action;
            table.push(`${prefix}${route} → ${actual}`);
            assert.equal(actual, EXPECTED[prefix][route], `${prefix}${route}`);
        }
    }
    // Deprecated folder parameter of /api/images/list
    assert.equal(classifyRequest('POST', '/api/images/list/SomeFolder').action, 'read');
    assert.ok(table.length >= 70);
});

test('classification: shrink checks, methods, normalization and generic freeing segments', () => {
    assert.equal(classifyRequest('POST', '/api/chats/save').shrink, 'chat');
    assert.equal(classifyRequest('POST', '/api/chats/group/save').shrink, 'group-chat');
    assert.equal(classifyRequest('POST', '/api/worldinfo/edit').shrink, 'worldinfo');
    assert.equal(classifyRequest('POST', '/api/chats/import').shrink, null);
    for (const p of ['/api/characters/edit', '/api/characters/edit-attribute', '/api/characters/merge-attributes']) {
        assert.deepEqual(classifyRequest('POST', p), { action: 'write', shrink: 'card-edit' }, p);
    }
    for (const p of ['/api/worldinfo/import', '/api/characters/duplicate', '/api/avatars/upload', '/api/content/importURL',
        '/api/content/importUUID', '/api/assets/download', '/api/groups/create', '/api/extensions/install']) {
        assert.deepEqual(classifyRequest('POST', p), { action: 'write', shrink: null }, p);
    }
    assert.equal(BLOCKED_ROUTES.size, 19);
    for (const key of BLOCKED_ROUTES.keys()) assert.equal(key, key.toLowerCase(), `${key} must be lowercase (normalizePath)`);

    // Express matches case-insensitively and ignores trailing slashes
    assert.equal(classifyRequest('POST', '/API/Files/Upload/').action, 'write');
    assert.equal(classifyRequest('POST', '/api//chats//save').action, 'write');
    assert.equal(classifyRequest('PUT', '/api/files/upload').action, 'write');
    assert.equal(classifyRequest('GET', '/api/files/upload').action, 'none');
    assert.equal(classifyRequest('GET', '/api/sprites/get').action, 'none');
    assert.equal(classifyRequest('DELETE', '/api/anything').action, 'free');

    for (const segment of ['delete', 'remove', 'rename', 'clear', 'purge']) {
        assert.equal(classifyRequest('POST', `/api/backgrounds/${segment}`).action, 'free', segment);
        assert.equal(classifyRequest('POST', `/api/files/sub/${segment}`).action, 'free', segment);
        assert.equal(classifyRequest('POST', `/api/whatever/${segment.toUpperCase()}`).action, 'free', segment);
    }
    // Unknown future routes under the upload prefixes are treated as writes
    assert.equal(classifyRequest('POST', '/api/images/new-upload-kind').action, 'write');
    // Not quota relevant
    for (const p of ['/api/settings/save', '/api/groups/edit', '/api/stc/users/check-in', '/api/stc/users/delete-single', '/', '/login']) {
        assert.notEqual(classifyRequest('POST', p).action, 'write', p);
    }
    assert.equal(classifyRequest('POST', '/api/stc/users/delete-single').action, 'none');
});

// ---------------------------------------------------------------------------
// Shrinking saves
// ---------------------------------------------------------------------------

function userDirs(name) {
    const root = path.join(tmpDir, 'users', name);
    const dirs = {
        root,
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group chats'),
        worlds: path.join(root, 'worlds'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    return dirs;
}

const chatLines = n => Array.from({ length: n }, (_, i) => ({ name: 'A', mes: `message number ${i} ` + 'x'.repeat(50) }));
const toJsonl = arr => arr.map(m => JSON.stringify(m)).join('\n');

test('shrink: chat save resolves like the official handler; shrinking allowed, growing / new / unsafe blocked', async () => {
    const dirs = userDirs('shrink-chat');
    const header = { user_name: 'U', character_name: 'Alice', chat_metadata: { integrity: 'abc' } };
    const existing = [header, ...chatLines(10)];
    writeFile(path.join(dirs.chats, 'Alice', 'Alice - 2026.jsonl'), toJsonl(existing));

    const body = chat => ({ avatar_url: 'Alice.png', file_name: 'Alice - 2026', chat });
    const target = resolveShrinkTarget('chat', body(existing), dirs);
    assert.equal(target.filePath, path.join(dirs.chats, 'Alice', 'Alice - 2026.jsonl'));
    assert.equal(target.newSize, Buffer.byteLength(toJsonl(existing)));

    assert.deepEqual((await checkShrinkingSave('chat', body([header, ...chatLines(9)]), dirs)).allowed, true);
    const same = await checkShrinkingSave('chat', body(existing), dirs);
    assert.equal(same.allowed, true, 'a byte-identical save keeps the stored data');
    assert.equal(same.unchanged, true);
    assert.equal(same.reason, 'unchanged');
    // Same size, different content: would still add a full-size official backup copy -> blocked
    const swapped = [header, ...chatLines(10)];
    swapped[3] = { ...swapped[3], mes: swapped[3].mes.replace('x', 'y') };
    assert.equal(resolveShrinkTarget('chat', body(swapped), dirs).newSize, target.newSize);
    const sameSize = await checkShrinkingSave('chat', body(swapped), dirs);
    assert.equal(sameSize.allowed, false);
    assert.equal(sameSize.reason, 'same_size_changed');
    const grown = await checkShrinkingSave('chat', body([header, ...chatLines(11)]), dirs);
    assert.equal(grown.allowed, false);
    assert.equal(grown.reason, 'grows');
    // Multi-byte content is measured in UTF-8 bytes like the file
    const cjk = [header, ...chatLines(9), { name: 'A', mes: '中'.repeat(40) }];
    assert.equal(resolveShrinkTarget('chat', body(cjk), dirs).newSize, Buffer.byteLength(toJsonl(cjk), 'utf8'));

    assert.equal((await checkShrinkingSave('chat', { ...body([header]), file_name: 'new chat' }, dirs)).reason, 'missing');
    assert.equal((await checkShrinkingSave('chat', { ...body([header]), avatar_url: '../Alice.png' }, dirs)).reason, 'unresolved');
    assert.equal((await checkShrinkingSave('chat', { ...body([header]), avatar_url: '..' }, dirs)).reason, 'unresolved');
    assert.equal((await checkShrinkingSave('chat', { ...body([header]), file_name: '../../x' }, dirs)).reason, 'missing', 'sanitized like the official handler');
    assert.equal((await checkShrinkingSave('chat', { ...body([header]), chat: 'not an array' }, dirs)).reason, 'unresolved');
    assert.equal((await checkShrinkingSave('chat', null, dirs)).reason, 'unresolved');
    // A directory at the target path is not a file
    fs.mkdirSync(path.join(dirs.chats, 'Alice', 'dir.jsonl'));
    assert.equal((await checkShrinkingSave('chat', { ...body([header]), file_name: 'dir' }, dirs)).reason, 'not_a_file');
    // A read error is not "shrinks"
    const eio = await checkShrinkingSave('chat', body([header]), dirs, async () => { throw fsError('EIO'); });
    assert.equal(eio.allowed, false);
    assert.equal(eio.reason, 'unreadable');
});

test('shrink: group chat and world info', async () => {
    const dirs = userDirs('shrink-group');
    const header = { chat_metadata: {} };
    writeFile(path.join(dirs.groupChats, '1700000000.jsonl'), toJsonl([header, ...chatLines(5)]));
    const g = chat => ({ id: '1700000000', chat });
    assert.equal(resolveShrinkTarget('group-chat', g([header]), dirs).filePath, path.join(dirs.groupChats, '1700000000.jsonl'));
    assert.equal((await checkShrinkingSave('group-chat', g([header, ...chatLines(4)]), dirs)).allowed, true);
    assert.equal((await checkShrinkingSave('group-chat', g([header, ...chatLines(6)]), dirs)).allowed, false);
    assert.equal((await checkShrinkingSave('group-chat', { chat: [header] }, dirs)).reason, 'unresolved');
    assert.equal((await checkShrinkingSave('group-chat', { id: '..', chat: [] }, dirs)).allowed, false);

    const world = n => ({ entries: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { uid: i, content: 'lore '.repeat(20) }])) });
    writeFile(path.join(dirs.worlds, 'My World.json'), JSON.stringify(world(5), null, 4));
    const w = data => ({ name: 'My World', data });
    assert.equal(resolveShrinkTarget('worldinfo', w(world(5)), dirs).newSize, Buffer.byteLength(JSON.stringify(world(5), null, 4)));
    assert.equal((await checkShrinkingSave('worldinfo', w(world(4)), dirs)).allowed, true);
    assert.equal((await checkShrinkingSave('worldinfo', w(world(5)), dirs)).allowed, true);
    assert.equal((await checkShrinkingSave('worldinfo', w(world(6)), dirs)).allowed, false);
    assert.equal((await checkShrinkingSave('worldinfo', { name: 'Other', data: world(1) }, dirs)).reason, 'missing');
    assert.equal((await checkShrinkingSave('worldinfo', { name: 'My World', data: { no: 'entries' } }, dirs)).reason, 'unresolved');
    assert.equal((await checkShrinkingSave('worldinfo', { name: '', data: world(1) }, dirs)).reason, 'unresolved');
    assert.equal((await checkShrinkingSave('worldinfo', { name: '../My World', data: world(1) }, dirs)).reason, 'missing', 'sanitized to a name inside worlds/');
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Fake Express response.
 */
function fakeRes() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.body = undefined;
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
        return res;
    };
    res.finish = (code = 200) => {
        res.statusCode = code;
        res.emit('finish');
    };
    return res;
}

/**
 * Run the middleware once.
 * @param {import('express').RequestHandler} mw
 * @param {object} req
 */
async function run(mw, req) {
    const res = fakeRes();
    let nextCalled = false;
    await mw({ headers: {}, ...req }, res, () => { nextCalled = true; });
    return { res, nextCalled };
}

function makeMiddleware(info, extra = {}) {
    const writes = [];
    const frees = [];
    const warnings = [];
    let infoCalls = 0;
    const mw = createStorageEnforceMiddleware({
        isEnabled: () => true,
        getStorageInfo: async () => {
            infoCalls++;
            if (info instanceof Error) throw info;
            return info;
        },
        onWrite: (handle, bytes) => writes.push({ handle, bytes }),
        onFree: handle => frees.push(handle),
        logger: { warn: (...args) => warnings.push(args.join(' ')) },
        ...extra,
    });
    return { mw, writes, frees, warnings, get infoCalls() { return infoCalls; } };
}

const OVER = { enabled: true, canWrite: false, unknown: false, usedMiB: 12.5, limitMiB: 10, percent: 125 };
const UNDER = { enabled: true, canWrite: true, unknown: false, usedMiB: 1, limitMiB: 10, percent: 10 };
const UNKNOWN = { enabled: true, canWrite: true, unknown: true, usedMiB: null, limitMiB: 10, percent: null };
const user = dirs => ({ profile: { handle: 'alice' }, directories: dirs });

test('middleware: over quota blocks growing writes with the unchanged 507 shape', async () => {
    const t = makeMiddleware(OVER);
    for (const p of ['/api/files/upload', '/api/images/upload', '/api/sprites/upload-zip', '/api/backgrounds/upload', '/api/characters/import', '/api/chats/import']) {
        const { res, nextCalled } = await run(t.mw, { method: 'POST', path: p, user: user(null), body: {} });
        assert.equal(nextCalled, false, p);
        assert.equal(res.statusCode, 507, p);
        assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error', 'limitMiB', 'message', 'percent', 'usedMiB']);
        assert.equal(res.body.code, 'STORAGE_QUOTA_EXCEEDED');
        assert.equal(res.body.error, true);
        assert.equal(res.body.usedMiB, 12.5);
        assert.match(res.body.message, /删除/);
        assert.match(res.body.message, /聊天备份/);
        assert.match(res.body.message, /背景/);
    }
    assert.equal(t.writes.length, 0);
});

test('middleware: over quota never blocks deletions / renames / reads; deletions recount after 2xx', async () => {
    const t = makeMiddleware(OVER);
    const allowed = [
        ['POST', '/api/files/delete'], ['POST', '/api/images/delete'], ['POST', '/api/sprites/delete'],
        ['POST', '/api/backgrounds/delete'], ['POST', '/api/backgrounds/rename'], ['POST', '/api/chats/delete'],
        ['POST', '/api/characters/delete'], ['POST', '/api/backups/chat/delete'], ['POST', '/api/chats/group/delete'],
        ['POST', '/api/worldinfo/delete'], ['POST', '/api/chats/rename'], ['DELETE', '/api/files/x'],
        ['POST', '/api/backgrounds/all'], ['POST', '/api/images/list'], ['POST', '/api/images/folders'],
        ['POST', '/api/files/verify'], ['POST', '/api/files/sanitize-filename'], ['POST', '/api/groups/edit'],
        ['POST', '/api/settings/save'], ['GET', '/api/files/upload'],
    ];
    for (const [method, p] of allowed) {
        const { res, nextCalled } = await run(t.mw, { method, path: p, user: user(null), body: {} });
        assert.equal(nextCalled, true, `${method} ${p}`);
        assert.equal(res.statusCode, 200);
        res.finish(200);
    }
    assert.equal(t.infoCalls, 0, 'no usage lookup for requests that are never blocked');
    assert.equal(t.frees.length, 12, 'recount scheduled for each successful deletion / rename');

    const failed = await run(t.mw, { method: 'POST', path: '/api/files/delete', user: user(null), body: {} });
    failed.res.finish(404);
    assert.equal(t.frees.length, 12, 'no recount after a failed deletion');
});

test('middleware: over quota allows shrinking chat / world info saves, blocks growing and new ones', async () => {
    const dirs = userDirs('mw-shrink');
    const header = { chat_metadata: {} };
    writeFile(path.join(dirs.chats, 'Bob', 'chat1.jsonl'), toJsonl([header, ...chatLines(8)]));
    writeFile(path.join(dirs.worlds, 'W.json'), JSON.stringify({ entries: { 1: { content: 'x'.repeat(500) } } }, null, 4));
    const t = makeMiddleware(OVER);
    const save = chat => ({ method: 'POST', path: '/api/chats/save', user: user(dirs), body: { avatar_url: 'Bob.png', file_name: 'chat1', chat } });

    const shrink = await run(t.mw, save([header, ...chatLines(3)]));
    assert.equal(shrink.nextCalled, true);
    shrink.res.finish(200);
    assert.equal(t.writes.length, 1, 'allowed writes are tracked');

    const grow = await run(t.mw, save([header, ...chatLines(9)]));
    assert.equal(grow.nextCalled, false);
    assert.equal(grow.res.statusCode, 507);

    const fresh = await run(t.mw, { ...save([header]), body: { avatar_url: 'Bob.png', file_name: 'brand new', chat: [header] } });
    assert.equal(fresh.res.statusCode, 507, 'a new chat file is blocked');

    const wiShrink = await run(t.mw, { method: 'POST', path: '/api/worldinfo/edit', user: user(dirs), body: { name: 'W', data: { entries: { 1: { content: 'x'.repeat(10) } } } } });
    assert.equal(wiShrink.nextCalled, true);
    const wiGrow = await run(t.mw, { method: 'POST', path: '/api/worldinfo/edit', user: user(dirs), body: { name: 'W', data: { entries: { 1: { content: 'x'.repeat(900) } } } } });
    assert.equal(wiGrow.res.statusCode, 507);

    // Directories fall back to getUserDirectories when req.user has none
    const t2 = makeMiddleware(OVER, { getDirectories: () => dirs });
    const viaHandle = await run(t2.mw, { ...save([header]), user: undefined, session: { handle: 'alice' } });
    assert.equal(viaHandle.nextCalled, true);
});

test('middleware: over quota an unchanged chat save is answered without the official handler (no backup copy); same-size edits 507', async () => {
    const dirs = userDirs('mw-unchanged');
    const header = { chat_metadata: {} };
    const chat = [header, ...chatLines(6)];
    writeFile(path.join(dirs.chats, 'Cy', 'c.jsonl'), toJsonl(chat));
    writeFile(path.join(dirs.groupChats, '1700000001.jsonl'), toJsonl(chat));
    const t = makeMiddleware(OVER);
    const save = (p, body) => ({ method: 'POST', path: p, user: user(dirs), body });

    const same = await run(t.mw, save('/api/chats/save', { avatar_url: 'Cy.png', file_name: 'c', chat }));
    assert.equal(same.nextCalled, false, 'the official handler (and its backup) is skipped');
    assert.equal(same.res.statusCode, 200);
    assert.deepEqual(same.res.body, { ok: true });
    const group = await run(t.mw, save('/api/chats/group/save', { id: '1700000001', chat }));
    assert.equal(group.nextCalled, false);
    assert.deepEqual(group.res.body, { ok: true });
    assert.equal(t.writes.length, 0, 'nothing written, nothing tracked');

    const edited = chat.map(m => ({ ...m }));
    edited[2].mes = edited[2].mes.replace('x', 'z');
    const changed = await run(t.mw, save('/api/chats/save', { avatar_url: 'Cy.png', file_name: 'c', chat: edited }));
    assert.equal(changed.res.statusCode, 507);
});

test('middleware: over quota, character card edits pass up to the allowance, larger or unknown sizes 507; new write routes 507', async () => {
    const t = makeMiddleware(OVER);
    for (const p of ['/api/characters/edit', '/api/characters/edit-attribute', '/api/characters/merge-attributes']) {
        const small = await run(t.mw, { method: 'POST', path: p, user: user(null), headers: { 'content-length': String(20_000) }, body: {} });
        assert.equal(small.nextCalled, true, p);
        small.res.finish(200);
        const big = await run(t.mw, { method: 'POST', path: p, user: user(null), headers: { 'content-length': String(enforce.CARD_EDIT_ALLOWANCE_BYTES + 1) }, body: {} });
        assert.equal(big.res.statusCode, 507, p);
        const unknown = await run(t.mw, { method: 'POST', path: p, user: user(null), body: {} });
        assert.equal(unknown.res.statusCode, 507, `${p} without Content-Length`);
    }
    assert.deepEqual(t.writes.map(w => w.bytes), [20_000, 20_000, 20_000]);
    for (const p of ['/api/worldinfo/import', '/api/characters/duplicate', '/api/avatars/upload', '/api/content/importURL',
        '/api/content/importUUID', '/api/assets/download', '/api/groups/create', '/api/extensions/install']) {
        const { res, nextCalled } = await run(t.mw, { method: 'POST', path: p, user: user(null), body: {} });
        assert.equal(nextCalled, false, p);
        assert.equal(res.statusCode, 507, p);
    }
    const u = makeMiddleware(UNDER);
    for (const p of ['/api/worldinfo/import', '/api/characters/edit', '/api/groups/create']) {
        assert.equal((await run(u.mw, { method: 'POST', path: p, user: user(null), body: {} })).nextCalled, true, `${p} under quota`);
    }
});

test('middleware: chat / world info saves add the growth of the file to the pending bytes, not the whole re-sent chat', async () => {
    const dirs = userDirs('mw-growth');
    const header = { chat_metadata: {} };
    const chat = [header, ...chatLines(40)];
    writeFile(path.join(dirs.chats, 'Dee', 'd.jsonl'), toJsonl(chat));
    const t = makeMiddleware(UNDER);
    const grown = [...chat, { name: 'A', mes: 'one more line' }];
    const body = { avatar_url: 'Dee.png', file_name: 'd', chat: grown };
    const length = Buffer.byteLength(JSON.stringify(body));
    const save = await run(t.mw, { method: 'POST', path: '/api/chats/save', user: user(dirs), headers: { 'content-length': String(length) }, body });
    assert.equal(save.nextCalled, true);
    save.res.finish(200);
    const oldSize = fs.statSync(path.join(dirs.chats, 'Dee', 'd.jsonl')).size;
    assert.equal(t.writes.length, 1);
    assert.ok(t.writes[0].bytes < 400, `growth ${t.writes[0].bytes}`);
    assert.equal(t.writes[0].bytes, Math.max(0, length - oldSize));

    // A new chat file counts in full; world info uses the exact (indented) new size
    const fresh = await run(t.mw, { method: 'POST', path: '/api/chats/save', user: user(dirs), body: { avatar_url: 'Dee.png', file_name: 'new', chat: [header] } });
    fresh.res.finish(200);
    assert.equal(t.writes[1].bytes, Buffer.byteLength(toJsonl([header])));
    const world = { entries: { 1: { content: 'w'.repeat(300) } } };
    writeFile(path.join(dirs.worlds, 'Wd.json'), JSON.stringify({ entries: {} }, null, 4));
    const wi = await run(t.mw, { method: 'POST', path: '/api/worldinfo/edit', user: user(dirs), headers: { 'content-length': '10' }, body: { name: 'Wd', data: world } });
    wi.res.finish(200);
    assert.equal(t.writes[2].bytes, Buffer.byteLength(JSON.stringify(world, null, 4)) - Buffer.byteLength(JSON.stringify({ entries: {} }, null, 4)));
    // Unresolvable save: the request size
    const odd = await run(t.mw, { method: 'POST', path: '/api/chats/save', user: user(dirs), headers: { 'content-length': '77' }, body: { chat: 'x' } });
    odd.res.finish(200);
    assert.equal(t.writes[3].bytes, 77);
});

test('middleware: failed quota checks are logged at most once a minute per user', async () => {
    const broken = makeMiddleware(new Error('store unavailable'));
    for (let i = 0; i < 20; i++) {
        const r = await run(broken.mw, { method: 'POST', path: '/api/files/upload', user: user(null), body: {} });
        assert.equal(r.nextCalled, true);
    }
    assert.equal(broken.warnings.length, 1);
});

test('middleware: over the limit only by pending estimates counts again before refusing', async () => {
    const infos = [];
    const t = createStorageEnforceMiddleware({
        isEnabled: () => true,
        getStorageInfo: async (handle, opts = {}) => {
            infos.push(opts.recount === true);
            return opts.recount
                ? { ...UNDER, pendingMiB: 0 }
                : { ...OVER, usedMiB: 11, limitMiB: 10, pendingMiB: 3, computedAt: Date.now() - 60_000 };
        },
        onWrite: () => {},
        onFree: () => {},
        logger: { warn: () => {} },
    });
    const ok = await run(t, { method: 'POST', path: '/api/chats/save', user: user(null), body: {} });
    assert.equal(ok.nextCalled, true);
    assert.deepEqual(infos, [false, true]);

    // Measured bytes alone over the limit, or a count younger than 5 s: refused without a recount
    for (const info of [
        { ...OVER, usedMiB: 14, limitMiB: 10, pendingMiB: 3, computedAt: Date.now() - 60_000 },
        { ...OVER, usedMiB: 11, limitMiB: 10, pendingMiB: 3, computedAt: Date.now() - 1000 },
    ]) {
        const calls = [];
        const mw = createStorageEnforceMiddleware({
            isEnabled: () => true,
            getStorageInfo: async (handle, opts = {}) => {
                calls.push(opts.recount === true);
                return info;
            },
            logger: { warn: () => {} },
        });
        const blocked = await run(mw, { method: 'POST', path: '/api/files/upload', user: user(null), body: {} });
        assert.equal(blocked.res.statusCode, 507);
        assert.deepEqual(calls, [false]);
    }
});

test('middleware: under quota tracks the request size of successful writes only', async () => {
    const t = makeMiddleware(UNDER);
    const ok = await run(t.mw, { method: 'POST', path: '/api/files/upload', user: user(null), headers: { 'content-length': '12345' }, body: {} });
    assert.equal(ok.nextCalled, true);
    ok.res.finish(200);
    assert.deepEqual(t.writes, [{ handle: 'alice', bytes: 12345 }]);
    const bad = await run(t.mw, { method: 'POST', path: '/api/files/upload', user: user(null), headers: { 'content-length': '5' }, body: {} });
    bad.res.finish(500);
    assert.equal(t.writes.length, 1);
    assert.equal(estimateRequestBytes({ headers: {}, body: { a: 'xyz' }, file: { size: 100 } }), 100 + Buffer.byteLength('{"a":"xyz"}'));
});

test('middleware: unknown usage, internal errors, anonymous requests and a disabled quota never block', async () => {
    const unknown = makeMiddleware(UNKNOWN);
    const u = await run(unknown.mw, { method: 'POST', path: '/api/files/upload', user: user(null), body: {} });
    assert.equal(u.nextCalled, true);
    assert.equal(unknown.warnings.length, 1, 'unknown usage is logged');
    await run(unknown.mw, { method: 'POST', path: '/api/files/upload', user: user(null), body: {} });
    assert.equal(unknown.warnings.length, 1, 'log throttled per user');

    const broken = makeMiddleware(new Error('store unavailable'));
    const b = await run(broken.mw, { method: 'POST', path: '/api/chats/save', user: user(null), body: {} });
    assert.equal(b.nextCalled, true);
    assert.equal(broken.warnings.length, 1);

    const anon = makeMiddleware(OVER);
    assert.equal((await run(anon.mw, { method: 'POST', path: '/api/files/upload', body: {} })).nextCalled, true);

    const off = makeMiddleware(OVER, { isEnabled: () => false });
    assert.equal((await run(off.mw, { method: 'POST', path: '/api/files/upload', user: user(null), body: {} })).nextCalled, true);
    assert.equal(off.infoCalls, 0);
});

test('middleware (real module): the default dependencies read the usage cache of the temp data root', async () => {
    const handle = 'real-user';
    const root = path.join(dataRoot, handle);
    const dirs = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats'), worlds: path.join(root, 'worlds') };
    const header = { chat_metadata: {} };
    writeFile(path.join(dirs.chats, 'Eve', 'c.jsonl'), toJsonl([header, ...chatLines(5)]));
    writeFile(path.join(root, 'backgrounds', 'huge.png'), 2 * MiB);
    invalidateUserUsage(handle);
    const mw = createStorageEnforceMiddleware({ logger: { warn: () => {} } });
    const req = extra => ({ method: 'POST', user: { profile: { handle }, directories: dirs }, body: {}, ...extra });

    const upload = await run(mw, req({ path: '/api/backgrounds/upload' }));
    assert.equal(upload.res.statusCode, 507);
    assert.equal(upload.res.body.limitMiB, 1);
    const del = await run(mw, req({ path: '/api/backgrounds/delete', body: { bg: 'huge.png' } }));
    assert.equal(del.nextCalled, true);
    const shrink = await run(mw, req({ path: '/api/chats/save', body: { avatar_url: 'Eve.png', file_name: 'c', chat: [header] } }));
    assert.equal(shrink.nextCalled, true);

    // The deletion frees the space: after the prompt recount the upload is allowed again
    fs.rmSync(path.join(root, 'backgrounds', 'huge.png'));
    del.res.finish(200);
    await sleep(quota.RECOUNT_AFTER_FREE_MS + 300);
    const again = await run(mw, req({ path: '/api/backgrounds/upload' }));
    assert.equal(again.nextCalled, true);
    invalidateUserUsage(handle);
});
