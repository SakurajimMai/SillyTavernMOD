/**
 * STC-MOD - json-store tests: read classification (ENOENT vs EIO / EACCES / EISDIR / ENOTDIR),
 * `.bak` recovery, `.corrupt-*` preservation, atomic writes, expect-missing conflicts, the data root
 * guard (injected stat), the watchdog and the HTTP 503 mapping. No server.
 * Run: node src/stc-mod/tests/json-store.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-json-store-'));
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(dataRoot);
globalThis.DATA_ROOT = dataRoot;
// config.js reads <cwd>/config.yaml: use an empty temp directory
const originalCwd = process.cwd();
process.chdir(tmpDir);

const store = await import('../services/json-store.js');
const { getStcDataDir } = await import('../config.js');
const {
    STORE_UNAVAILABLE_CODE,
    STORE_UNAVAILABLE_MESSAGE,
    StoreConflictError,
    StoreUnavailableError,
    checkDataRoot,
    createJsonStore,
    initDataRootGuard,
    isStoreUnavailableError,
    readJsonFile,
    respondStoreError,
    startDataRootWatchdog,
    storeErrorHandler,
    writeJsonFileAtomic,
} = store;

let fileCounter = 0;
/**
 * Fresh file path in its own directory.
 * @param {string} [name]
 * @returns {string}
 */
function freshFile(name = 'store.json') {
    const dir = path.join(dataRoot, `case-${++fileCounter}`);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
}

/**
 * Copy of node:fs where some functions fail for one path.
 * @param {Record<string, string>} failures fs function name -> error code
 * @param {string} target Path that fails
 */
function failingFs(failures, target) {
    const fake = Object.create(fs);
    for (const [fn, code] of Object.entries(failures)) {
        fake[fn] = (...args) => {
            if (String(args[0]) === target) throw Object.assign(new Error(`${code}: injected ${fn}`), { code });
            return fs[fn](...args);
        };
    }
    return fake;
}

/** Real guard on the temp data root (inactive unless it is on its own mount). */
function resetGuard() {
    initDataRootGuard({ root: dataRoot });
}

/**
 * Guard with an injected stat: the data root is on a mount (dev 7, `/` has dev 1).
 * @returns {{setDev: (dev: number|null) => void}}
 */
function mountedGuard() {
    let dev = 7;
    initDataRootGuard({
        root: dataRoot,
        statSync: (p) => {
            if (p === path.parse(p).root) return { dev: 1 };
            if (p === dataRoot) {
                if (dev === null) throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
                return { dev };
            }
            return { dev: p.startsWith(dataRoot) ? 7 : 1 };
        },
    });
    return { setDev: (value) => { dev = value; } };
}

/**
 * Wait for a promise while a ref'd timer keeps the event loop alive (the watchdog timer is unref'd).
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
async function keepAlive(promise) {
    const timer = setInterval(() => {}, 1000);
    try {
        return await promise;
    } finally {
        clearInterval(timer);
    }
}

const quiet = (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
};

test.beforeEach(() => resetGuard());

test('missing file (ENOENT) -> missing, no data', () => {
    const file = freshFile();
    assert.deepEqual(readJsonFile(file), { status: 'missing', data: undefined });
    assert.equal(readJsonFile(path.join(path.dirname(file), 'no-dir', 'x.json')).status, 'missing', 'missing parent directory too');
});

test('valid file -> ok', () => {
    const file = freshFile();
    fs.writeFileSync(file, JSON.stringify([1, 2]));
    assert.deepEqual(readJsonFile(file, { validate: Array.isArray }), { status: 'ok', data: [1, 2] });
});

for (const code of ['EIO', 'ENOTCONN', 'EACCES', 'EPERM', 'ETIMEDOUT', 'EBUSY']) {
    test(`read error ${code} -> StoreUnavailableError (never an empty store)`, (t) => {
        quiet(t);
        const file = freshFile();
        fs.writeFileSync(file, '[1]');
        const fakeFs = failingFs({ readFileSync: code }, file);
        assert.throws(() => readJsonFile(file, { fs: fakeFs }), (error) => {
            assert.ok(error instanceof StoreUnavailableError);
            assert.equal(error.code, STORE_UNAVAILABLE_CODE);
            assert.equal(error.status, 503);
            assert.equal(error.message, STORE_UNAVAILABLE_MESSAGE);
            assert.match(error.detail, new RegExp(code));
            assert.equal(error.cause.code, code);
            return true;
        });
        assert.equal(fs.readFileSync(file, 'utf8'), '[1]', 'file untouched');
    });
}

test('EISDIR (a directory where the file should be) and ENOTDIR -> unavailable', (t) => {
    quiet(t);
    const file = freshFile();
    fs.mkdirSync(file);
    assert.throws(() => readJsonFile(file), (e) => isStoreUnavailableError(e) && /EISDIR/.test(e.detail));
    const blocker = freshFile('blocker');
    fs.writeFileSync(blocker, 'x');
    assert.throws(() => readJsonFile(path.join(blocker, 'store.json')), (e) => isStoreUnavailableError(e) && /ENOTDIR/.test(e.detail));
});

test('unparseable main + valid .bak -> recovered; corrupt copy kept; .bak not overwritten by the broken file', (t) => {
    quiet(t);
    const file = freshFile();
    fs.writeFileSync(file, '{ broken');
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ a: 1 }));
    const result = readJsonFile(file, { validate: store.isPlainObject });
    assert.equal(result.status, 'recovered');
    assert.deepEqual(result.data, { a: 1 });
    const kept = fs.readdirSync(path.dirname(file)).filter(f => f.startsWith('store.json.corrupt-'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), '{ broken');

    // Reading again does not pile up copies of the same broken file
    readJsonFile(file, { validate: store.isPlainObject });
    assert.equal(fs.readdirSync(path.dirname(file)).filter(f => f.startsWith('store.json.corrupt-')).length, 1);

    writeJsonFileAtomic(file, { a: 2 }, { backup: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { a: 1 }, 'good .bak kept');
    writeJsonFileAtomic(file, { a: 3 }, { backup: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { a: 2 }, 'normal .bak refresh afterwards');
});

test('unparseable main, no .bak -> corrupt (kept as .corrupt-*); invalid .bak kept too', (t) => {
    quiet(t);
    const file = freshFile();
    fs.writeFileSync(file, '[1, 2');
    let result = readJsonFile(file);
    assert.equal(result.status, 'corrupt');
    assert.equal(result.data, undefined);
    assert.equal(fs.readdirSync(path.dirname(file)).filter(f => f.startsWith('store.json.corrupt-')).length, 1);

    const other = freshFile();
    fs.writeFileSync(other, 'null');
    fs.writeFileSync(`${other}.bak`, '{ also broken');
    result = readJsonFile(other, { validate: store.isPlainObject });
    assert.equal(result.status, 'corrupt', 'a value failing validation is unreadable');
    const names = fs.readdirSync(path.dirname(other));
    assert.equal(names.filter(f => f.startsWith('store.json.corrupt-')).length, 1);
    assert.equal(names.filter(f => f.startsWith('store.json.bak.corrupt-')).length, 1);
});

test('validation failure -> corrupt; recovered when the .bak validates', (t) => {
    quiet(t);
    const file = freshFile();
    fs.writeFileSync(file, JSON.stringify({ not: 'an array' }));
    assert.equal(readJsonFile(file, { validate: Array.isArray }).status, 'corrupt');
    const other = freshFile();
    fs.writeFileSync(other, JSON.stringify({ not: 'an array' }));
    fs.writeFileSync(`${other}.bak`, '[7]');
    assert.deepEqual(readJsonFile(other, { validate: Array.isArray }), { status: 'recovered', data: [7], reason: 'unexpected content' });
});

test('corrupt file that cannot be copied aside -> unavailable (never replaced unpreserved)', (t) => {
    quiet(t);
    const file = freshFile();
    fs.writeFileSync(file, '{ broken');
    const fakeFs = failingFs({ copyFileSync: 'ENOSPC' }, file);
    assert.throws(() => readJsonFile(file, { fs: fakeFs }), isStoreUnavailableError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('unreadable .bak (EIO) while the main file is corrupt -> unavailable', (t) => {
    quiet(t);
    const file = freshFile();
    fs.writeFileSync(file, '{ broken');
    fs.writeFileSync(`${file}.bak`, '[]');
    const fakeFs = failingFs({ readFileSync: 'EIO' }, `${file}.bak`);
    assert.throws(() => readJsonFile(file, { fs: fakeFs }), isStoreUnavailableError);
});

test('missing main file + valid .bak -> recovered (mainMissing), never an empty store; the .bak survives the next writes', (t) => {
    quiet(t);
    const file = freshFile();
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ alice: { oauthUserId: '42' } }));
    const result = readJsonFile(file, { validate: store.isPlainObject });
    assert.deepEqual(result, { status: 'recovered', data: { alice: { oauthUserId: '42' } }, reason: 'main file missing', mainMissing: true });
    assert.equal(readJsonFile(file, { backup: false }).status, 'missing', 'backup: false keeps the plain classification');

    // Through a store: the first write recreates the file (expect-missing), later writes refresh .bak from it
    const s = createJsonStore({ label: 'Test', file: () => file, validate: store.isPlainObject, empty: () => ({}) });
    s.update((data) => { data.bob = {}; });
    s.update((data) => { data.carol = {}; });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['alice', 'bob', 'carol']);
    assert.ok(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).alice, 'the recovered data is still in .bak');

    // A main file that appears before the first write is merged by reloading, not overwritten
    const raced = freshFile();
    fs.writeFileSync(`${raced}.bak`, JSON.stringify({ old: 1 }));
    const r = createJsonStore({ label: 'Test', file: () => raced, validate: store.isPlainObject, empty: () => ({}) });
    let runs = 0;
    r.update((data) => {
        runs++;
        if (runs === 1) fs.writeFileSync(raced, JSON.stringify({ theirs: 1 }));
        data.ours = 1;
    });
    assert.equal(runs, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(raced, 'utf8')), { theirs: 1, ours: 1 });
});

test('missing main file + unreadable .bak -> missing, the .bak is kept as .corrupt-* first; EIO on .bak -> unavailable', (t) => {
    quiet(t);
    const file = freshFile();
    fs.writeFileSync(`${file}.bak`, '{ broken');
    assert.deepEqual(readJsonFile(file, { validate: store.isPlainObject }), { status: 'missing', data: undefined });
    const kept = fs.readdirSync(path.dirname(file)).filter(f => f.startsWith('store.json.bak.corrupt-'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), '{ broken');

    const other = freshFile();
    fs.writeFileSync(`${other}.bak`, '{}');
    assert.throws(() => readJsonFile(other, { fs: failingFs({ readFileSync: 'EIO' }, `${other}.bak`) }), isStoreUnavailableError);
});

test('a successful read is checked against the guard again (no stale copy from under a vanished mount)', (t) => {
    quiet(t);
    const guard = mountedGuard();
    const file = freshFile();
    fs.writeFileSync(file, '[1]');
    const fake = Object.create(fs);
    fake.readFileSync = (...args) => {
        const data = fs.readFileSync(...args);
        guard.setDev(null); // the mount vanished while (or right after) the file was read
        return data;
    };
    assert.throws(() => readJsonFile(file, { fs: fake }), isStoreUnavailableError);
    guard.setDev(7);
    assert.deepEqual(readJsonFile(file).data, [1]);
});

test('expect-missing write: a failing temp cleanup after the link does not report the write as failed', (t) => {
    quiet(t);
    const file = freshFile();
    const fake = Object.create(fs);
    fake.rmSync = () => { throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); };
    writeJsonFileAtomic(file, ['created'], { expectMissing: true, fs: fake });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['created']);
});

test('atomic write: temp + rename, original mode kept, .bak of the previous content, no temp left', () => {
    const file = freshFile();
    fs.writeFileSync(file, '{"v":1}');
    fs.chmodSync(file, 0o640);
    writeJsonFileAtomic(file, { v: 2 }, { backup: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 2 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{"v":1}');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), []);
    writeJsonFileAtomic(file, { v: 3 });
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{"v":1}', 'no .bak refresh without backup: true');
});

test('failed write keeps the old file, removes the temp file and is unavailable', (t) => {
    quiet(t);
    const file = freshFile();
    fs.writeFileSync(file, '[1]');
    const fake = Object.create(fs);
    fake.renameSync = () => { throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); };
    assert.throws(() => writeJsonFileAtomic(file, [2], { fs: fake }), isStoreUnavailableError);
    assert.equal(fs.readFileSync(file, 'utf8'), '[1]');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), []);
});

test('expect-missing write: creates a new file; a file that appeared meanwhile -> conflict, untouched', () => {
    const file = freshFile();
    writeJsonFileAtomic(file, [1], { expectMissing: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [1]);
    assert.throws(() => writeJsonFileAtomic(file, [2], { expectMissing: true }), StoreConflictError);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [1]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), []);

    // Race after the existence check: the hard link fails with EEXIST
    const raced = freshFile();
    const fake = Object.create(fs);
    fake.linkSync = (from, to) => {
        fs.writeFileSync(to, '"other writer"');
        return fs.linkSync(from, to);
    };
    assert.throws(() => writeJsonFileAtomic(raced, [3], { expectMissing: true, fs: fake }), StoreConflictError);
    assert.equal(fs.readFileSync(raced, 'utf8'), '"other writer"');
    assert.deepEqual(fs.readdirSync(path.dirname(raced)).filter(f => f.endsWith('.tmp')), []);
});

test('expect-missing write without hard links falls back to an exclusive create', () => {
    const file = freshFile();
    const fake = Object.create(fs);
    fake.linkSync = () => { throw Object.assign(new Error('EPERM: no links'), { code: 'EPERM' }); };
    writeJsonFileAtomic(file, { x: 1 }, { expectMissing: true, fs: fake });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 1 });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), []);
});

test('createJsonStore.update: creates when missing, reloads on conflict instead of overwriting, skips unchanged writes', (t) => {
    quiet(t);
    const file = freshFile();
    const s = createJsonStore({ label: 'Test', file: () => file, validate: Array.isArray, empty: () => [] });
    assert.deepEqual(s.read(), []);

    // Another writer creates the file between our read (missing) and our write
    let runs = 0;
    const result = s.update((items) => {
        runs++;
        if (runs === 1) fs.writeFileSync(file, JSON.stringify(['theirs']));
        items.push('ours');
        return items.length;
    });
    assert.equal(runs, 2, 'the mutator ran again on the reloaded data');
    assert.equal(result, 2);
    assert.deepEqual(s.read(), ['theirs', 'ours']);

    const renames = t.mock.method(fs, 'renameSync');
    assert.equal(s.update(() => 'no change'), 'no change');
    assert.equal(renames.mock.calls.length, 0, 'nothing written when the data did not change');
    s.update(items => { items.push('more'); });
    assert.equal(renames.mock.calls.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), ['theirs', 'ours']);
});

test('createJsonStore: read errors propagate (no empty fallback), corrupt reads start empty', (t) => {
    quiet(t);
    const file = freshFile();
    const s = createJsonStore({ label: 'Test', file: () => file, validate: Array.isArray, empty: () => [] });
    fs.mkdirSync(file);
    assert.throws(() => s.read(), isStoreUnavailableError);
    assert.throws(() => s.update(items => items.push(1)), isStoreUnavailableError);
    fs.rmdirSync(file);
    fs.writeFileSync(file, '{ bad');
    assert.deepEqual(s.load(), { data: [], status: 'corrupt' });
    s.update(items => { items.push(1); });
    assert.deepEqual(s.read(), [1]);
});

test('data root guard: inactive when the data root is on the root filesystem', () => {
    initDataRootGuard({ root: dataRoot, statSync: () => ({ dev: 1 }) });
    assert.equal(store.getDataRootGuardState().mounted, false);
    assert.deepEqual(checkDataRoot(), { ok: true });
});

test('data root guard: mounted data root that disappears (ENOENT) or changes device -> unavailable, nothing created', (t) => {
    quiet(t);
    const guard = mountedGuard();
    const state = store.getDataRootGuardState();
    assert.equal(state.mounted, true);
    assert.equal(state.dev, 7);
    assert.deepEqual(checkDataRoot(), { ok: true });

    const file = freshFile();
    guard.setDev(null); // mount gone: the path resolves to the empty directory underneath
    assert.equal(checkDataRoot().ok, false);
    assert.throws(() => readJsonFile(file), isStoreUnavailableError, 'ENOENT because of a lost mount is not "missing"');
    assert.throws(() => writeJsonFileAtomic(file, [1]), isStoreUnavailableError);
    assert.equal(fs.existsSync(file), false, 'no write attempted');

    guard.setDev(8); // something else mounted / the underlying filesystem
    assert.throws(() => readJsonFile(file), (e) => isStoreUnavailableError(e) && /changed device/.test(e.detail));

    guard.setDev(7); // back
    assert.equal(readJsonFile(file).status, 'missing');
});

test('getStcDataDir() never creates the STC directory while the mount is gone', (t) => {
    quiet(t);
    const stcDir = path.join(dataRoot, 'stc-mod');
    fs.rmSync(stcDir, { recursive: true, force: true });
    const guard = mountedGuard();
    guard.setDev(9);
    assert.throws(() => getStcDataDir(), isStoreUnavailableError);
    assert.equal(fs.existsSync(stcDir), false);
    guard.setDev(7);
    assert.equal(getStcDataDir(), stcDir);
    assert.equal(fs.statSync(stcDir).isDirectory(), true);

    // A file where the directory should be is unavailable, not "created"
    fs.rmSync(stcDir, { recursive: true, force: true });
    fs.writeFileSync(stcDir, 'x');
    assert.throws(() => getStcDataDir(), isStoreUnavailableError);
    fs.rmSync(stcDir);
});

test('getStcDataDir() checks the guard again before creating the directory (mount lost after the first check)', (t) => {
    quiet(t);
    const stcDir = path.join(dataRoot, 'stc-mod');
    fs.rmSync(stcDir, { recursive: true, force: true });
    let rootStats = 0;
    initDataRootGuard({
        root: dataRoot,
        statSync: (p) => {
            if (p === path.parse(p).root) return { dev: 1 };
            if (p === dataRoot && ++rootStats > 1) return { dev: 99 }; // gone right after startup's stat
            return { dev: p.startsWith(dataRoot) ? 7 : 1 };
        },
    });
    // 1st stat: startup; 2nd (first check of getStcDataDir) already sees the other device
    assert.throws(() => getStcDataDir(), isStoreUnavailableError);
    assert.equal(fs.existsSync(stcDir), false);

    rootStats = 0;
    let checks = 0;
    initDataRootGuard({
        root: dataRoot,
        statSync: (p) => {
            if (p === path.parse(p).root) return { dev: 1 };
            if (p === dataRoot) return { dev: ++checks > 2 ? 99 : 7 }; // startup + first check fine, then gone
            return { dev: p.startsWith(dataRoot) ? 7 : 1 };
        },
    });
    assert.throws(() => getStcDataDir(), isStoreUnavailableError, 'ENOENT of the directory is checked against the guard again');
    assert.equal(fs.existsSync(stcDir), false, 'nothing created on the filesystem underneath');
});

test('data root guard: a missing data root at startup watches its nearest existing ancestor', () => {
    const root = path.join(tmpDir, 'not-yet', 'data');
    const state = initDataRootGuard({ root });
    assert.equal(state.anchor, tmpDir);
    assert.deepEqual(checkDataRoot(), { ok: true });
});

test('watchdog: off when disabled or not mounted; exits(1) and blocks the stores on loss', async (t) => {
    quiet(t);
    initDataRootGuard({ root: dataRoot, statSync: () => ({ dev: 1 }) });
    assert.equal(startDataRootWatchdog({ exit: () => assert.fail('must not exit') }), null, 'not a mount');

    let dev = 7;
    mountedGuard();
    assert.equal(startDataRootWatchdog({ enabled: false }), null, 'disabled');

    const exits = [];
    let resolveExit;
    const exited = new Promise(resolve => { resolveExit = resolve; });
    const watchdog = startDataRootWatchdog({
        intervalMs: 5,
        exit: (code) => { exits.push(code); resolveExit(); },
        statAsync: async () => ({ dev }),
    });
    assert.ok(watchdog);
    assert.equal(watchdog.timer.hasRef(), false, 'unref\'d timer');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(exits, [], 'healthy mount: no exit');
    dev = 99;
    await keepAlive(exited);
    assert.deepEqual(exits, [1]);
    assert.equal(checkDataRoot().ok, false, 'lost state is sticky (no writes before the exit completes)');
    assert.throws(() => writeJsonFileAtomic(freshFile(), [1]), isStoreUnavailableError);
    watchdog.stop();
});

test('watchdog: a stat that fails or hangs counts as a loss', async (t) => {
    quiet(t);
    for (const statAsync of [
        async () => { throw Object.assign(new Error('ENOTCONN'), { code: 'ENOTCONN' }); },
        () => new Promise(() => {}),
    ]) {
        mountedGuard();
        const exited = new Promise((resolve) => {
            const watchdog = startDataRootWatchdog({ intervalMs: 5, stallMs: 40, exit: resolve, statAsync });
            t.after(() => watchdog?.stop());
        });
        assert.equal(await keepAlive(exited), 1);
        store.stopDataRootWatchdog();
    }
});

test('data root guard: a stat error other than ENOENT at startup (dead FUSE mount) -> unusable until restart; the watchdog exits', (t) => {
    quiet(t);
    const dead = (p) => {
        if (p.startsWith(dataRoot)) throw Object.assign(new Error('Transport endpoint is not connected'), { code: 'ENOTCONN' });
        return { dev: 1 };
    };
    const state = initDataRootGuard({ root: dataRoot, statSync: dead });
    assert.match(state.lostReason, /ENOTCONN/);
    assert.equal(checkDataRoot().ok, false);
    assert.throws(() => readJsonFile(freshFile()), isStoreUnavailableError);
    assert.equal(startDataRootWatchdog({ enabled: false }), null);
    assert.equal(checkDataRoot().ok, false, 'watchdog off: still unavailable (no silent "missing")');
    const exits = [];
    assert.equal(startDataRootWatchdog({ exit: code => exits.push(code), statAsync: async () => ({ dev: 7 }) }), null);
    assert.deepEqual(exits, [1], 'watchdog on: exits so that Docker restarts the container');

    // stcDataRootMustBeMount: a data root that is not on its own mount is unusable
    const plain = initDataRootGuard({ root: dataRoot, statSync: () => ({ dev: 1 }), requireMount: true });
    assert.match(plain.lostReason, /stcDataRootMustBeMount/);
    assert.equal(checkDataRoot().ok, false);
    assert.equal(initDataRootGuard({ root: dataRoot, statSync: () => ({ dev: 1 }) }).lostReason, null, 'not required by default');
});

test('watchdog running: a loss observed by a store access is sticky (a same-device remount is not trusted) and the next check exits', async (t) => {
    quiet(t);
    const guard = mountedGuard();
    const exits = [];
    let resolveExit;
    const exited = new Promise(resolve => { resolveExit = resolve; });
    const watchdog = startDataRootWatchdog({
        intervalMs: 20,
        exit: (code) => { exits.push(code); resolveExit(); },
        statAsync: async () => ({ dev: 7 }), // the watchdog's own stats never see the short loss
    });
    t.after(() => watchdog?.stop());
    const file = freshFile();
    guard.setDev(null); // blip between two watchdog checks
    assert.throws(() => readJsonFile(file), isStoreUnavailableError);
    guard.setDev(7); // the mount is back with the same device id
    assert.equal(checkDataRoot().ok, false, 'sticky');
    assert.throws(() => writeJsonFileAtomic(file, [1]), isStoreUnavailableError, 'nothing changed during the loss is flushed');
    assert.equal(fs.existsSync(file), false);
    assert.equal(await keepAlive(exited), undefined);
    assert.deepEqual(exits, [1]);
    watchdog.stop();

    // Without a watchdog, a blip is not sticky (the store works again)
    const again = mountedGuard();
    again.setDev(null);
    assert.equal(checkDataRoot().ok, false);
    again.setDev(7);
    assert.equal(checkDataRoot().ok, true);
});

test('watchdog running: a loss observed by a store access or request exits within about 1 s, not at the next check', async (t) => {
    quiet(t);
    const guard = mountedGuard();
    let resolveExit;
    const exited = new Promise(resolve => { resolveExit = resolve; });
    const exits = [];
    const watchdog = startDataRootWatchdog({
        intervalMs: 60_000, // the next regular check is far away
        exit: (code) => { exits.push(code); resolveExit(); },
        statAsync: async () => ({ dev: 7 }),
    });
    t.after(() => watchdog?.stop());
    const started = Date.now();
    guard.setDev(null);
    assert.equal(checkDataRoot().ok, false);
    await keepAlive(exited);
    const elapsed = Date.now() - started;
    assert.deepEqual(exits, [1]);
    assert.ok(elapsed >= 900 && elapsed < 3000, `exited after ${elapsed} ms`);
    watchdog.stop();
});

test('watchdog worker thread: a device change is reported to the main thread, which exits(1); stop() ends the worker', async (t) => {
    quiet(t);
    mountedGuard(); // the guard recorded dev 7; the worker stats the real data root (another device)
    let resolveExit;
    const exited = new Promise(resolve => { resolveExit = resolve; });
    const watchdog = startDataRootWatchdog({ intervalMs: 20, exit: resolveExit });
    t.after(() => watchdog?.stop());
    assert.ok(watchdog?.worker, 'runs in a worker thread');
    assert.equal(await keepAlive(exited), 1);
    assert.match(store.getDataRootGuardState().lostReason, /changed device/);
    assert.equal(checkDataRoot().ok, false);
    const worker = watchdog.worker;
    const workerExit = new Promise(resolve => worker.once('exit', resolve));
    watchdog.stop();
    await keepAlive(workerExit);
    assert.equal(startDataRootWatchdog({ enabled: false }), null, 'stopped: can be started again');
});

test('HTTP: StoreUnavailableError -> 503 JSON for API calls, short text for pages; other errors untouched', async (t) => {
    quiet(t);
    const app = express();
    app.get('/api/sync', () => { throw new StoreUnavailableError('test'); });
    app.get('/api/async', (req, res, next) => { Promise.reject(new StoreUnavailableError('test')).catch(next); });
    app.get('/api/caught', (req, res) => {
        try {
            throw new StoreUnavailableError('test');
        } catch (error) {
            if (respondStoreError(req, res, error)) return;
            res.status(500).end();
        }
    });
    app.get('/page', () => { throw new StoreUnavailableError('test'); });
    app.get('/api/other', () => { throw new Error('boom'); });
    app.use(storeErrorHandler);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(500).json({ fallback: err.message }));
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

    for (const url of ['/api/sync', '/api/async', '/api/caught']) {
        const res = await fetch(base + url);
        assert.equal(res.status, 503, url);
        assert.deepEqual(await res.json(), { error: '数据存储暂时不可用，请稍后重试', code: 'STORE_UNAVAILABLE' });
        assert.equal(res.headers.get('retry-after'), '30');
    }
    const page = await fetch(base + '/page', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 503);
    assert.match(page.headers.get('content-type'), /text\/plain/);
    assert.equal(await page.text(), '503 数据存储暂时不可用，请稍后重试');
    const other = await fetch(base + '/api/other');
    assert.equal(other.status, 500);
    assert.deepEqual(await other.json(), { fallback: 'boom' });
    assert.equal(respondStoreError({}, {}, new Error('x')), false);
});

test.after(() => {
    store.stopDataRootWatchdog();
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
