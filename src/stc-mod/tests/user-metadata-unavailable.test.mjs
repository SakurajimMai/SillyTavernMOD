/**
 * STC-MOD - user-metadata.js when its file cannot be read: no empty cache, every access throws
 * StoreUnavailableError, the load is retried at most every 5 s, nothing is ever written before a
 * successful load; a file that appears while the store was treated as new is merged, not overwritten.
 * Run: node src/stc-mod/tests/user-metadata-unavailable.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-meta-unavailable-'));
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(dataRoot);
globalThis.DATA_ROOT = dataRoot;
const originalCwd = process.cwd();
process.chdir(tmpDir);

const meta = await import('../user-metadata.js');
const { StoreUnavailableError, initDataRootGuard, isStoreUnavailableError } = await import('../services/json-store.js');

const stcDir = path.join(dataRoot, 'stc-mod');
const metaPath = path.join(stcDir, 'user-metadata.json');
const T0 = Date.UTC(2026, 8, 29, 8, 0, 0);
const STORED = Object.freeze({
    _migrated_lastActiveAt: 1,
    alice: { email: 'alice@example.com', oauthProvider: 'qrole', oauthUserId: 'q-1', createdAt: 1, lastActiveAt: 1 },
});
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Fresh store state: cache dropped, metadata file = `initial` (null: none), mocked Date at T0.
 * @param {import('node:test').TestContext} t
 * @param {object|null} initial
 */
function setup(t, initial = STORED) {
    initDataRootGuard({ root: dataRoot });
    assert.equal(meta.invalidateCache(), true);
    fs.rmSync(stcDir, { recursive: true, force: true });
    fs.mkdirSync(stcDir, { recursive: true });
    if (initial) fs.writeFileSync(metaPath, JSON.stringify(initial));
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
}

/**
 * Make reads of the metadata file fail with `code` until restored.
 * @param {import('node:test').TestContext} t
 * @param {string} code
 */
function failReads(t, code = 'EIO') {
    const original = fs.readFileSync;
    const reads = [];
    const mock = t.mock.method(fs, 'readFileSync', function (file, ...rest) {
        if (String(file) === metaPath) {
            reads.push(file);
            throw Object.assign(new Error(`${code}: injected`), { code });
        }
        return original.call(this, file, ...rest);
    });
    return { reads, restore: () => mock.mock.restore() };
}

/**
 * Count every write attempt on the metadata file (temp files next to it included).
 * @param {import('node:test').TestContext} t
 */
function spyWrites(t) {
    const touches = [];
    for (const fn of ['writeFileSync', 'openSync', 'renameSync', 'linkSync', 'copyFileSync']) {
        const original = fs[fn];
        t.mock.method(fs, fn, function (...args) {
            if (args.some(a => typeof a === 'string' && a.startsWith(metaPath))) touches.push(fn);
            return original.apply(this, args);
        });
    }
    return touches;
}

test('first load fails (EIO): every access throws, findUserByOAuth never returns null, nothing is written', (t) => {
    setup(t);
    const before = fs.readFileSync(metaPath, 'utf8');
    const failing = failReads(t, 'EIO');
    const writes = spyWrites(t);

    for (const access of [
        () => meta.getUserMeta('alice'),
        () => meta.findUserByOAuth('qrole', 'q-1'),
        () => meta.findUserByEmail('alice@example.com'),
        () => meta.getAllUserMeta(),
        () => meta.isUserExpired('alice'),
        () => meta.getUserStats(),
        () => meta.setUserMeta('mallory', { oauthProvider: 'qrole', oauthUserId: 'q-1' }, { immediate: true }),
        () => meta.recordLogin('alice'),
        () => meta.recordActivity('alice'),
        () => meta.deleteUserMeta('alice'),
        () => meta.ensureUserMetadataLoaded(),
    ]) {
        assert.throws(access, (error) => error instanceof StoreUnavailableError && error.code === 'STORE_UNAVAILABLE');
    }
    assert.equal(meta.getMetadataLoadState().loaded, false);
    assert.match(meta.getMetadataLoadState().error, /EIO/);
    assert.equal(meta.flushMetadata(), true, 'nothing pending');
    process.listeners('exit').filter(fn => fn.name === 'stcFlushUserMetadataOnExit').forEach(fn => fn());
    assert.deepEqual(writes, [], 'no write of any kind');
    failing.restore();
    assert.equal(fs.readFileSync(metaPath, 'utf8'), before, 'file untouched');
    assert.deepEqual(fs.readdirSync(stcDir), ['user-metadata.json'], 'no temp / .bak / .corrupt files');
});

test('failed load is retried at most every 5 s, then the stored data is used (never an empty store)', (t) => {
    setup(t);
    const failing = failReads(t, 'ENOTCONN');
    assert.throws(() => meta.getUserMeta('alice'), isStoreUnavailableError);
    assert.equal(failing.reads.length, 1);
    failing.restore(); // storage is back

    t.mock.timers.tick(4999);
    assert.throws(() => meta.getUserMeta('alice'), isStoreUnavailableError, 'still inside the retry window');
    t.mock.timers.tick(1);
    assert.equal(meta.getUserMeta('alice').email, 'alice@example.com');
    assert.equal(meta.findUserByOAuth('qrole', 'q-1'), 'alice');
    assert.equal(meta.getMetadataLoadState().loaded, true);
});

test('lost data root mount at the first load: unavailable, the STC directory is not recreated underneath', (t) => {
    setup(t, null);
    fs.rmSync(stcDir, { recursive: true, force: true });
    let dev = 7;
    initDataRootGuard({
        root: dataRoot,
        statSync: (p) => (p === path.parse(p).root ? { dev: 1 } : { dev: p === dataRoot ? dev : 7 }),
    });
    dev = 8; // the mount disappeared: the path now resolves to another filesystem
    assert.throws(() => meta.getUserMeta('alice'), isStoreUnavailableError);
    assert.throws(() => meta.findUserByOAuth('qrole', 'q-1'), isStoreUnavailableError);
    assert.equal(fs.existsSync(stcDir), false, 'no mkdir on the underlying filesystem');
    initDataRootGuard({ root: dataRoot });
});

test('store unavailable after a successful load: the cache stays the source of truth, flushes retry', (t) => {
    setup(t);
    assert.equal(meta.getUserMeta('alice').email, 'alice@example.com');
    let dev = 7;
    initDataRootGuard({
        root: dataRoot,
        statSync: (p) => (p === path.parse(p).root ? { dev: 1 } : { dev: p === dataRoot ? dev : 7 }),
    });
    dev = 9;
    meta.setUserMeta('alice', { email: 'changed@example.com' }, { immediate: true });
    assert.equal(meta.getUserMeta('alice').email, 'changed@example.com', 'readers keep working from memory');
    assert.equal(meta.getMetadataFlushState().pending, 'real', 'the failed flush stays pending');
    assert.equal(readJson(metaPath).alice.email, 'alice@example.com', 'nothing written while the mount is gone');

    dev = 7; // mount back
    t.mock.timers.tick(meta.ACTIVITY_FLUSH_MS); // armed retry
    assert.equal(readJson(metaPath).alice.email, 'changed@example.com');
    assert.equal(meta.getMetadataFlushState().pending, 'none');
    initDataRootGuard({ root: dataRoot });
});

test('missing store: a metadata file that appears before the first write is merged, not overwritten', (t) => {
    setup(t, null);
    // The first write (migration sentinel at load) fails, e.g. a flaky mount
    const original = fs.linkSync;
    const link = t.mock.method(fs, 'linkSync', function () {
        throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    });
    assert.equal(meta.getUserMeta('alice'), null, 'missing file = empty store');
    assert.equal(fs.existsSync(metaPath), false);
    link.mock.restore();
    assert.equal(fs.linkSync, original);

    // Meanwhile the real file shows up (mount back / another writer)
    fs.writeFileSync(metaPath, JSON.stringify(STORED));
    meta.setUserMeta('bob', { email: 'bob@example.com' });
    assert.equal(meta.flushMetadata(), true);
    const written = readJson(metaPath);
    assert.equal(written.alice.email, 'alice@example.com', 'existing data kept');
    assert.equal(written.alice.oauthUserId, 'q-1');
    assert.equal(written.bob.email, 'bob@example.com', 'in-memory change kept');
    assert.equal(meta.findUserByOAuth('qrole', 'q-1'), 'alice', 'the merged link is visible');
});

test('missing file with a valid .bak: the backup is used (links intact), the file is recreated and the .bak keeps the data', (t) => {
    setup(t, null);
    fs.writeFileSync(`${metaPath}.bak`, JSON.stringify(STORED));
    assert.equal(meta.findUserByOAuth('qrole', 'q-1'), 'alice', 'never an empty store while the backup is valid');
    meta.setUserMeta('bob', { email: 'b@example.com' }, { immediate: true });
    meta.setUserMeta('bob', { email: 'b2@example.com' }, { immediate: true });
    assert.equal(readJson(metaPath).alice.oauthUserId, 'q-1');
    assert.equal(readJson(metaPath).bob.email, 'b2@example.com');
    assert.equal(readJson(`${metaPath}.bak`).alice.oauthUserId, 'q-1', 'the last good copy is not replaced by a nearly empty store');
});

test('corrupt file without .bak still starts empty (kept as .corrupt-*), unlike a read error', (t) => {
    setup(t, null);
    fs.writeFileSync(metaPath, '{ truncated');
    assert.equal(meta.getUserMeta('alice'), null);
    assert.equal(fs.readdirSync(stcDir).filter(f => f.startsWith('user-metadata.json.corrupt-')).length, 1);
});

test.after(() => {
    meta.invalidateCache();
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
