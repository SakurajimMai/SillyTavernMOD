/**
 * STC-MOD - user-metadata.json flush policy tests (scheduler with a fake clock + the real module
 * against a temp data root with mocked timers; no server, no network).
 * Run: node src/stc-mod/tests/user-metadata-flush.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FLUSH_LEVEL, createFlushScheduler } from '../services/flush-scheduler.js';

const REAL_MS = 5000;
const ACTIVITY_MS = 60_000;

// ---------------------------------------------------------------------------
// Scheduler (pure, fake clock)
// ---------------------------------------------------------------------------

/**
 * Minimal fake clock: timers run in due order when time advances.
 */
function fakeClock(start = 1_000_000) {
    let t = start;
    let nextId = 1;
    /** @type {Map<number, {at: number, fn: () => void, unrefed: boolean}>} */
    const timers = new Map();
    return {
        timers,
        now: () => t,
        setTimer(fn, ms) {
            const id = nextId++;
            const entry = { at: t + ms, fn, unrefed: false };
            timers.set(id, entry);
            return { id, unref() { entry.unrefed = true; } };
        },
        clearTimer(timer) {
            timers.delete(timer.id);
        },
        advance(ms) {
            const end = t + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                t = due[1].at;
                due[1].fn();
            }
            t = end;
        },
    };
}

function makeScheduler(clock, flushImpl = () => true) {
    const flushes = [];
    const errors = [];
    const scheduler = createFlushScheduler({
        flush: (info) => {
            flushes.push({ at: clock.now(), ...info });
            return flushImpl(info);
        },
        realDelayMs: REAL_MS,
        activityDelayMs: ACTIVITY_MS,
        clock,
        onError: (e) => errors.push(e),
    });
    return { scheduler, flushes, errors };
}

test('scheduler: activity-only is written once, 60 s after the first ping (fixed window)', () => {
    const clock = fakeClock();
    const t0 = clock.now();
    const { scheduler, flushes } = makeScheduler(clock);
    scheduler.markActivity();
    assert.deepEqual(scheduler.getState(), { pending: 'activity', dueAt: t0 + ACTIVITY_MS });
    for (let i = 0; i < 11; i++) {
        clock.advance(5000);
        scheduler.markActivity(); // later pings do not extend the window
    }
    assert.equal(scheduler.getState().dueAt, t0 + ACTIVITY_MS);
    assert.equal(clock.timers.size, 1, 'a single timer');
    assert.equal(flushes.length, 0);
    clock.advance(ACTIVITY_MS - 55_000);
    assert.deepEqual(flushes, [{ at: t0 + ACTIVITY_MS, real: false }]);
    assert.deepEqual(scheduler.getState(), { pending: 'none', dueAt: null });
    assert.equal(clock.timers.size, 0, 'no timer left behind');
});

test('scheduler: real change flushes after 5 s; activity during a real batch rides along', () => {
    const clock = fakeClock();
    const t0 = clock.now();
    const { scheduler, flushes } = makeScheduler(clock);
    scheduler.markReal();
    clock.advance(1000);
    scheduler.markReal(); // same batch, deadline unchanged
    scheduler.markActivity();
    assert.deepEqual(scheduler.getState(), { pending: 'real', dueAt: t0 + REAL_MS });
    clock.advance(REAL_MS - 1001);
    assert.equal(flushes.length, 0);
    clock.advance(1);
    assert.deepEqual(flushes, [{ at: t0 + REAL_MS, real: true }]);
    clock.advance(ACTIVITY_MS * 2);
    assert.equal(flushes.length, 1, 'the activity was written with the real change');
    assert.equal(clock.timers.size, 0);
});

test('scheduler: a real change during a pending activity window is brought forward to 5 s', () => {
    const clock = fakeClock();
    const t0 = clock.now();
    const { scheduler, flushes } = makeScheduler(clock);
    scheduler.markActivity();
    clock.advance(30_000);
    scheduler.markReal();
    assert.deepEqual(scheduler.getState(), { pending: 'real', dueAt: t0 + 35_000 });
    assert.equal(clock.timers.size, 1, 'the activity timer was replaced, not duplicated');
    clock.advance(REAL_MS);
    assert.deepEqual(flushes, [{ at: t0 + 35_000, real: true }]);
    clock.advance(ACTIVITY_MS);
    assert.equal(flushes.length, 1);
    assert.equal(clock.timers.size, 0);
});

test('scheduler: a real change right before the activity deadline keeps the earlier deadline', () => {
    const clock = fakeClock();
    const t0 = clock.now();
    const { scheduler, flushes } = makeScheduler(clock);
    scheduler.markActivity();
    clock.advance(58_000);
    scheduler.markReal();
    assert.equal(scheduler.getState().dueAt, t0 + ACTIVITY_MS, 'earliest due time wins');
    clock.advance(2000);
    assert.deepEqual(flushes, [{ at: t0 + ACTIVITY_MS, real: true }], 'flushed as a real change (.bak refresh)');
});

test('scheduler: flushNow writes everything pending synchronously and disarms the timer', () => {
    const clock = fakeClock();
    const { scheduler, flushes } = makeScheduler(clock);
    assert.equal(scheduler.flushNow(), true, 'nothing pending is a no-op');
    assert.equal(flushes.length, 0);
    scheduler.markActivity();
    assert.equal(scheduler.flushNow(), true);
    assert.deepEqual(flushes.map(f => f.real), [false]);
    scheduler.markActivity();
    scheduler.markReal();
    scheduler.flushNow();
    assert.deepEqual(flushes.map(f => f.real), [false, true]);
    assert.equal(clock.timers.size, 0);
    clock.advance(ACTIVITY_MS * 2);
    assert.equal(flushes.length, 2);
});

test('scheduler: timers are unref\'d', () => {
    const clock = fakeClock();
    const { scheduler } = makeScheduler(clock);
    scheduler.markActivity();
    scheduler.markReal();
    assert.equal(clock.timers.size, 1);
    assert.ok([...clock.timers.values()].every(e => e.unrefed));
    scheduler.flushNow();
});

test('scheduler: a failed flush keeps the batch pending and retries; a new real change is not delayed', () => {
    const clock = fakeClock();
    const t0 = clock.now();
    let fail = 2;
    const { scheduler, flushes, errors } = makeScheduler(clock, () => {
        if (fail-- === 2) return false;
        if (fail === 0) throw new Error('disk full');
        return true;
    });
    scheduler.markReal();
    clock.advance(REAL_MS); // fails (returns false)
    assert.deepEqual(scheduler.getState(), { pending: 'real', dueAt: t0 + REAL_MS + ACTIVITY_MS });
    scheduler.markActivity(); // does not bring the retry forward
    assert.equal(scheduler.getState().dueAt, t0 + REAL_MS + ACTIVITY_MS);
    clock.advance(1000);
    scheduler.markReal(); // a new real change is flushed within 5 s
    assert.equal(scheduler.getState().dueAt, t0 + REAL_MS + 1000 + REAL_MS);
    clock.advance(REAL_MS); // throws
    assert.equal(errors.length, 1);
    assert.equal(scheduler.getState().pending, 'real');
    clock.advance(ACTIVITY_MS); // succeeds
    assert.deepEqual(flushes.map(f => f.real), [true, true, true]);
    assert.deepEqual(scheduler.getState(), { pending: 'none', dueAt: null });
    assert.equal(clock.timers.size, 0);
});

test('scheduler: a change made from inside the flush callback starts a new batch', () => {
    const clock = fakeClock();
    let scheduler;
    let reentered = false;
    ({ scheduler } = makeScheduler(clock, () => {
        if (!reentered) {
            reentered = true;
            scheduler.markReal();
        }
        return true;
    }));
    scheduler.markActivity();
    scheduler.flushNow();
    assert.equal(scheduler.getState().pending, 'real');
    assert.equal(clock.timers.size, 1);
    scheduler.flushNow();
    assert.deepEqual(scheduler.getState(), { pending: 'none', dueAt: null });
    assert.equal(FLUSH_LEVEL.REAL > FLUSH_LEVEL.ACTIVITY, true);
});

// ---------------------------------------------------------------------------
// user-metadata.js against a temp data root (mocked setTimeout + Date)
// ---------------------------------------------------------------------------

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-meta-flush-'));
globalThis.DATA_ROOT = dataRoot;
const meta = await import('../user-metadata.js');

const metaPath = path.join(dataRoot, 'stc-mod', 'user-metadata.json');
const bakPath = `${metaPath}.bak`;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const INITIAL = Object.freeze({
    _migrated_lastActiveAt: 1,
    alice: { email: 'alice@example.com', createdAt: 1, lastActiveAt: 1 },
    bob: { email: 'bob@example.com', createdAt: 1, lastActiveAt: 1 },
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Fresh metadata file + cache, mocked clock at T0 and fs spies for the test.
 * @param {import('node:test').TestContext} t
 * @param {object} [initial]
 * @param {Array<'setTimeout'|'Date'>} [apis] Mocked timer APIs
 */
function setupMeta(t, initial = INITIAL, apis = ['setTimeout', 'Date']) {
    meta.invalidateCache();
    fs.rmSync(path.join(dataRoot, 'stc-mod'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dataRoot, 'stc-mod'), { recursive: true });
    if (initial) fs.writeFileSync(metaPath, JSON.stringify(initial));
    t.mock.timers.enable({ apis, now: T0 });
    meta.getUserMeta('alice'); // load outside the counted window
    const renames = t.mock.method(fs, 'renameSync');
    const copies = t.mock.method(fs, 'copyFileSync');
    return {
        writes: () => renames.mock.calls.filter(c => c.arguments[1] === metaPath).length,
        bakCopies: () => copies.mock.calls.filter(c => c.arguments[1] === bakPath).length,
        tick: (ms) => t.mock.timers.tick(ms),
    };
}

/**
 * Leave no armed (mocked) timer behind for the next test.
 */
function teardownMeta() {
    meta.flushMetadata();
    assert.deepEqual(meta.getMetadataFlushState(), { pending: 'none', dueAt: null });
}

test('constants: 5 s for real changes, 60 s for activity', () => {
    assert.equal(meta.FLUSH_DEBOUNCE_MS, 5000);
    assert.equal(meta.ACTIVITY_FLUSH_MS, 60_000);
    assert.equal(meta.isActivityOnlyPatch({ lastActiveAt: 1 }), true);
    assert.equal(meta.isActivityOnlyPatch({ lastActiveAt: 1, lastLoginAt: 1 }), false);
    assert.equal(meta.isActivityOnlyPatch({ email: 'x' }), false);
    assert.equal(meta.isActivityOnlyPatch({}), false);
});

test('metadata: activity-only -> one write after 60 s, no .bak copy, readers see it at once', (t) => {
    const s = setupMeta(t);
    try {
        meta.recordActivity('alice');
        assert.equal(meta.getUserMeta('alice').lastActiveAt, T0, 'cache is the source of truth');
        assert.equal(meta.getMetadataFlushState().pending, 'activity');
        s.tick(ACTIVITY_MS - 1);
        assert.equal(s.writes(), 0);
        s.tick(1);
        assert.equal(s.writes(), 1);
        assert.equal(s.bakCopies(), 0);
        assert.equal(fs.existsSync(bakPath), false);
        assert.equal(readJson(metaPath).alice.lastActiveAt, T0);
        assert.deepEqual(meta.getMetadataFlushState(), { pending: 'none', dueAt: null });
    } finally {
        teardownMeta();
    }
});

test('metadata: real change -> written within 5 s with a .bak of the previous file', (t) => {
    const s = setupMeta(t);
    try {
        meta.setUserMeta('alice', { email: 'new@example.com' });
        assert.equal(meta.getUserMeta('alice').email, 'new@example.com');
        s.tick(REAL_MS - 1);
        assert.equal(s.writes(), 0);
        s.tick(1);
        assert.equal(s.writes(), 1);
        assert.equal(s.bakCopies(), 1);
        assert.equal(readJson(metaPath).alice.email, 'new@example.com');
        assert.equal(readJson(bakPath).alice.email, 'alice@example.com', '.bak = state before the real change');
        s.tick(ACTIVITY_MS * 2);
        assert.equal(s.writes(), 1, 'no further writes');
    } finally {
        teardownMeta();
    }
});

test('metadata: real change during a pending activity window is flushed at 5 s (with the activity)', (t) => {
    const s = setupMeta(t);
    try {
        meta.recordActivity('alice');
        s.tick(10_000);
        meta.setUserMeta('bob', { storageLimitMiB: 800 });
        s.tick(REAL_MS - 1);
        assert.equal(s.writes(), 0);
        s.tick(1);
        assert.equal(s.writes(), 1);
        assert.equal(s.bakCopies(), 1);
        const saved = readJson(metaPath);
        assert.equal(saved.alice.lastActiveAt, T0, 'pending activity written too');
        assert.equal(saved.bob.storageLimitMiB, 800);
        s.tick(ACTIVITY_MS);
        assert.equal(s.writes(), 1, 'the activity timer did not fire again');
    } finally {
        teardownMeta();
    }
});

test('metadata: many heartbeats (several users) -> one write per 60 s window, never a .bak', (t) => {
    const s = setupMeta(t);
    try {
        for (let i = 0; i < 36; i++) { // every 5 s for 3 minutes
            meta.recordActivity(i % 2 ? 'alice' : 'bob');
            s.tick(5000);
        }
        assert.equal(s.writes(), 3);
        assert.equal(s.bakCopies(), 0);
        const saved = readJson(metaPath);
        assert.equal(saved.alice.lastActiveAt, T0 + 175_000);
        assert.equal(saved.bob.lastActiveAt, T0 + 170_000);
    } finally {
        teardownMeta();
    }
});

test('metadata: .bak keeps the state before the last real change while activity moves on', (t) => {
    const s = setupMeta(t);
    try {
        meta.setUserMeta('alice', { email: 'v2@example.com' });
        s.tick(REAL_MS);
        meta.recordActivity('alice');
        s.tick(ACTIVITY_MS);
        assert.equal(s.writes(), 2);
        assert.equal(s.bakCopies(), 1);
        assert.equal(readJson(bakPath).alice.email, 'alice@example.com');
        assert.equal(readJson(bakPath).alice.lastActiveAt, 1, '.bak lastActiveAt may be older');
        meta.setUserMeta('alice', { email: 'v3@example.com' }, { immediate: true });
        assert.equal(readJson(bakPath).alice.email, 'v2@example.com');
        assert.equal(readJson(bakPath).alice.lastActiveAt, T0 + REAL_MS, 'includes the activity flushed before');
    } finally {
        teardownMeta();
    }
});

test('metadata: immediate flush writes synchronously (pending activity included) and leaves no timer', (t) => {
    const s = setupMeta(t);
    try {
        meta.recordActivity('alice');
        s.tick(1000);
        meta.setUserMeta('bob', { expiresAt: 0 }, { immediate: true });
        assert.equal(s.writes(), 1);
        assert.equal(s.bakCopies(), 1);
        assert.equal(readJson(metaPath).alice.lastActiveAt, T0);
        assert.equal(readJson(metaPath).bob.expiresAt, 0);
        assert.deepEqual(meta.getMetadataFlushState(), { pending: 'none', dueAt: null });
        s.tick(ACTIVITY_MS * 2);
        assert.equal(s.writes(), 1);

        meta.deleteUserMeta('bob');
        assert.equal(s.writes(), 2, 'deleteUserMeta is immediate');
        assert.equal(readJson(metaPath).bob, undefined);
    } finally {
        teardownMeta();
    }
});

test('metadata: exit hook and flushMetadata() flush pending activity', (t) => {
    const s = setupMeta(t);
    try {
        const onExit = process.listeners('exit').find(fn => fn.name === 'stcFlushUserMetadataOnExit');
        assert.ok(onExit, 'exit hook registered');
        assert.ok(process.listeners('SIGINT').some(fn => fn.name === 'stcFlushUserMetadataOnSigint'));
        assert.ok(process.listeners('SIGTERM').some(fn => fn.name === 'stcFlushUserMetadataOnSigterm'));

        meta.recordActivity('alice');
        onExit();
        assert.equal(s.writes(), 1);
        assert.equal(s.bakCopies(), 0, 'activity-only exit flush does not refresh .bak');
        assert.equal(readJson(metaPath).alice.lastActiveAt, T0);

        s.tick(1000);
        meta.recordActivity('bob');
        meta.setUserMeta('alice', { email: 'exit@example.com' });
        onExit();
        assert.equal(s.writes(), 2);
        assert.equal(s.bakCopies(), 1);
        assert.equal(readJson(metaPath).alice.email, 'exit@example.com');
        assert.equal(readJson(metaPath).bob.lastActiveAt, T0 + 1000);

        s.tick(1000);
        meta.recordActivity('alice');
        assert.equal(meta.flushMetadata(), true);
        assert.equal(s.writes(), 3);
        assert.equal(readJson(metaPath).alice.lastActiveAt, T0 + 2000);
        s.tick(ACTIVITY_MS * 2);
        assert.equal(s.writes(), 3, 'no timer left behind');
    } finally {
        teardownMeta();
    }
});

test('metadata: a corrupted main file is recovered from .bak and the .bak is not overwritten by it', (t) => {
    meta.invalidateCache();
    fs.mkdirSync(path.join(dataRoot, 'stc-mod'), { recursive: true });
    fs.writeFileSync(metaPath, '{ broken json');
    fs.writeFileSync(bakPath, JSON.stringify(INITIAL));
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    try {
        assert.equal(meta.getUserMeta('alice').email, 'alice@example.com');
        meta.setUserMeta('alice', { email: 'fixed@example.com' }, { immediate: true });
        assert.equal(readJson(metaPath).alice.email, 'fixed@example.com');
        assert.equal(readJson(bakPath).alice.email, 'alice@example.com', 'good backup kept');
        meta.setUserMeta('alice', { email: 'next@example.com' }, { immediate: true });
        assert.equal(readJson(bakPath).alice.email, 'fixed@example.com', 'normal .bak refresh afterwards');
    } finally {
        teardownMeta();
    }
});

test('metadata: first load without the migration sentinel writes once (real change)', (t) => {
    const s = setupMeta(t, null);
    try {
        meta.invalidateCache();
        fs.writeFileSync(metaPath, JSON.stringify({ carol: { createdAt: 5 } }));
        t.mock.method(console, 'log', () => {});
        assert.equal(meta.getUserMeta('carol').lastActiveAt, 5);
        assert.equal(s.writes(), 1);
        assert.equal(readJson(metaPath).carol.lastActiveAt, 5);
        assert.ok(readJson(metaPath)._migrated_lastActiveAt);
        assert.deepEqual(meta.getMetadataFlushState(), { pending: 'none', dueAt: null });
    } finally {
        teardownMeta();
    }
});

test('metadata: a forward wall-clock step does not delay a real change (monotonic deadlines)', (t) => {
    // Only the timers are mocked: Date.now() is stepped by hand, the scheduler must not care
    const s = setupMeta(t, INITIAL, ['setTimeout']);
    try {
        const wall = Date.now();
        meta.recordActivity('alice'); // activity window: 60 s
        s.tick(1000);
        t.mock.method(Date, 'now', () => wall + 3_600_000); // NTP step / VM resume: +1 h
        meta.setUserMeta('bob', { email: 'stepped@example.com' });
        s.tick(REAL_MS - 1);
        assert.equal(s.writes(), 0);
        s.tick(1);
        assert.equal(s.writes(), 1, 'written 5 s after the real change, not at the end of the activity window');
        assert.equal(readJson(metaPath).bob.email, 'stepped@example.com');
    } finally {
        teardownMeta();
    }
});

test('metadata: invalidateCache() keeps the cache (and the pending change) when the flush fails', (t) => {
    const s = setupMeta(t);
    try {
        const error = t.mock.method(console, 'error', () => {});
        meta.setUserMeta('alice', { email: 'unsaved@example.com' });
        const failing = t.mock.method(fs, 'writeFileSync', () => { throw new Error('EIO'); });
        assert.equal(meta.invalidateCache(), false);
        failing.mock.restore();
        assert.ok(error.mock.calls.some(c => /cache kept/.test(String(c.arguments[0]))));
        assert.equal(meta.getUserMeta('alice').email, 'unsaved@example.com', 'change still in memory');
        assert.equal(meta.getMetadataFlushState().pending, 'real');
        assert.equal(readJson(metaPath).alice.email, 'alice@example.com');
        s.tick(ACTIVITY_MS); // armed retry
        assert.equal(readJson(metaPath).alice.email, 'unsaved@example.com', 'the retry wrote the change');
        assert.equal(meta.invalidateCache(), true);
    } finally {
        teardownMeta();
    }
});

/**
 * Corrupt-file fixtures: fresh stc-mod dir with the given raw main / .bak contents (null = absent).
 * @param {import('node:test').TestContext} t
 * @param {string|null} main
 * @param {string|null} bak
 */
function setupCorrupt(t, main, bak) {
    meta.invalidateCache();
    const dir = path.join(dataRoot, 'stc-mod');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    if (main !== null) fs.writeFileSync(metaPath, main);
    if (bak !== null) fs.writeFileSync(bakPath, bak);
    const error = t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    return {
        error,
        kept: (name) => fs.readdirSync(dir).filter(f => f.startsWith(`${name}.corrupt-`)).map(f => path.join(dir, f)),
    };
}

test('metadata: unparseable main file and no .bak -> kept as .corrupt-*, store starts empty', (t) => {
    const truncated = JSON.stringify(INITIAL).slice(0, 40);
    const c = setupCorrupt(t, truncated, null);
    try {
        assert.equal(meta.getUserMeta('alice'), null);
        const kept = c.kept('user-metadata.json');
        assert.equal(kept.length, 1, 'the unreadable main file was set aside');
        assert.equal(fs.readFileSync(kept[0], 'utf8'), truncated, 'raw bytes preserved');
        assert.ok(readJson(metaPath)._migrated_lastActiveAt, 'a fresh store was written');
        meta.setUserMeta('carol', { email: 'carol@example.com' }, { immediate: true });
        assert.equal(fs.readFileSync(kept[0], 'utf8'), truncated, 'later writes never touch it');
        assert.ok(c.error.mock.calls.some(call => /Kept the unreadable user-metadata\.json/.test(String(call.arguments[0]))));
    } finally {
        teardownMeta();
    }
});

test('metadata: unparseable main file and unparseable .bak -> both kept', (t) => {
    const c = setupCorrupt(t, '{ broken main', '[1, 2');
    try {
        assert.equal(meta.getUserMeta('alice'), null);
        const main = c.kept('user-metadata.json').filter(f => !f.includes('.bak.'));
        const bak = c.kept('user-metadata.json.bak');
        assert.equal(main.length, 1);
        assert.equal(bak.length, 1);
        assert.equal(fs.readFileSync(main[0], 'utf8'), '{ broken main');
        assert.equal(fs.readFileSync(bak[0], 'utf8'), '[1, 2');
        meta.setUserMeta('carol', { email: 'carol@example.com' }, { immediate: true });
        assert.equal(readJson(metaPath).carol.email, 'carol@example.com');
    } finally {
        teardownMeta();
    }
});

test('metadata: a JSON value that is not an object counts as unreadable (recovered from .bak)', (t) => {
    setupCorrupt(t, 'null', JSON.stringify(INITIAL));
    try {
        assert.equal(meta.getUserMeta('alice').email, 'alice@example.com');
    } finally {
        teardownMeta();
    }
});

test('metadata: SIGTERM/SIGINT hooks flush; they exit only when no other handler takes the signal', (t) => {
    const s = setupMeta(t);
    const exit = t.mock.method(process, 'exit', () => {});
    const hook = (signal, name) => process.rawListeners(signal).find(fn => (fn.listener ?? fn).name === name);
    try {
        // Official graceful shutdown registered (server-main.js exitProcess): it exits, not STC-MOD
        const official = () => {};
        process.on('SIGTERM', official);
        try {
            meta.recordActivity('alice');
            hook('SIGTERM', 'stcFlushUserMetadataOnSigterm')('SIGTERM');
            assert.equal(s.writes(), 1, 'flushed on SIGTERM');
            assert.equal(exit.mock.calls.length, 0, 'left the exit to the other handler');
        } finally {
            process.removeListener('SIGTERM', official);
        }

        // Nobody else listening (early startup): flush and exit(0)
        const onSigint = hook('SIGINT', 'stcFlushUserMetadataOnSigint');
        const others = process.rawListeners('SIGINT').filter(fn => fn !== onSigint);
        for (const fn of others) process.removeListener('SIGINT', fn);
        try {
            meta.recordActivity('bob');
            onSigint('SIGINT');
        } finally {
            for (const fn of others) process.on('SIGINT', fn);
        }
        assert.equal(s.writes(), 2, 'flushed on SIGINT');
        assert.deepEqual(exit.mock.calls.map(c => c.arguments), [[0]]);
    } finally {
        teardownMeta();
    }
});

test.after(() => {
    meta.invalidateCache();
    fs.rmSync(dataRoot, { recursive: true, force: true });
});
