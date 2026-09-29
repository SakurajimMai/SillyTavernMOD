/**
 * STC-MOD - storage expansion codes on the json-store helpers (a read error is never "no codes",
 * redeeming never consumes a code while the metadata is unavailable, HTTP 503 STORE_UNAVAILABLE)
 * and account deletion refusing to remove anything while a data store is unavailable.
 * Run: node src/stc-mod/tests/storage-codes.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// The official modules read config.yaml at import time: point them at a temp config first.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-storage-codes-'));
const configPath = path.join(tmpDir, 'config.yaml');
fs.writeFileSync(configPath, [
    'userStorage:',
    '  enabled: true',
    '  defaultLimitMiB: 100',
    '  dailyCheckInMiB: 10',
    '',
].join('\n'));
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(path.join(dataRoot, 'stc-mod'), { recursive: true });
globalThis.DATA_ROOT = dataRoot;
// STC-MOD reads <cwd>/config.yaml
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { setConfigFilePath } = await import('../../util.js');
setConfigFilePath(configPath);
const { StoreUnavailableError, initDataRootGuard, storeErrorHandler } = await import('../services/json-store.js');
const meta = await import('../user-metadata.js');
const quota = await import('../services/storage-quota.js');
const { router: userStorageRouter } = await import('../routes/private/user-storage.js');
const { router: userExtendRouter } = await import('../routes/private/user-extend.js');
const { deleteUserWithLock } = await import('../services/user-deletion.js');

const stcDir = path.join(dataRoot, 'stc-mod');
const codesPath = path.join(stcDir, 'storage-codes.json');
const metaPath = path.join(stcDir, 'user-metadata.json');

const quiet = (t) => {
    for (const level of ['error', 'warn', 'log', 'info']) t.mock.method(console, level, () => {});
};

/**
 * Make fs.readFileSync fail with `code` for one path (restored with the test).
 * @param {import('node:test').TestContext} t
 * @param {string} file
 * @param {string} code
 */
function failRead(t, file, code = 'EIO') {
    const original = fs.readFileSync;
    return t.mock.method(fs, 'readFileSync', function (target, ...rest) {
        if (String(target) === file) throw Object.assign(new Error(`${code}: injected`), { code });
        return original.call(this, target, ...rest);
    });
}

/**
 * Start an express app with the STC routers (user `handle`, admin), return its base URL.
 * @param {import('node:test').TestContext} t
 * @param {string} handle
 */
async function serve(t, handle = 'alice') {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { profile: { handle, admin: true } };
        next();
    });
    app.use('/api/stc/user-storage', userStorageRouter);
    app.use('/api/stc/users', userExtendRouter);
    app.use(storeErrorHandler);
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise(resolve => server.once('listening', resolve));
    return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

/**
 * @param {string} url
 * @param {object} [body] POST body (GET without)
 */
async function call(url, body) {
    const response = await fetch(url, body === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

test.beforeEach(() => {
    initDataRootGuard({ root: dataRoot });
    fs.writeFileSync(metaPath, JSON.stringify({ _migrated_lastActiveAt: 1, alice: { createdAt: 1, storageLimitMiB: 100 } }));
    meta.invalidateCache();
    for (const suffix of ['', '.bak']) fs.rmSync(codesPath + suffix, { force: true });
});

test('storage codes: missing file = no codes; generate / list / use / delete round trip', (t) => {
    quiet(t);
    assert.deepEqual(quota.getAllStorageCodes(), []);
    const created = quota.generateStorageCodes(2, 50, 'admin');
    assert.equal(created.length, 2);
    assert.deepEqual(quota.getAllStorageCodes().map(c => c.code).sort(), created.map(c => c.code).sort());

    const used = quota.useStorageCode(created[0].code.toLowerCase(), 'alice');
    assert.deepEqual(used, { success: true, addedMiB: 50, newLimitMiB: 150 });
    assert.equal(meta.getUserMeta('alice').storageLimitMiB, 150);
    assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).alice.storageLimitMiB, 150, 'flushed at once');
    assert.equal(quota.useStorageCode(created[0].code, 'alice').success, false, 'single use');
    assert.equal(quota.useStorageCode(12345, 'alice').success, false, 'non-string code');

    assert.equal(quota.deleteStorageCode(created[1].code), true);
    assert.equal(quota.deleteStorageCode(created[1].code), false);
    assert.equal(quota.getAllStorageCodes().length, 1);
    assert.ok(fs.existsSync(`${codesPath}.bak`), '.bak kept on rewrite');
});

test('storage codes: a read error is never "no codes" (nothing written); corrupt file recovered from .bak', (t) => {
    quiet(t);
    const [code] = quota.generateStorageCodes(1, 20, 'admin');
    quota.generateStorageCodes(1, 30, 'admin'); // second write refreshes .bak
    const before = fs.readFileSync(codesPath, 'utf8');

    for (const errno of ['EIO', 'ENOTCONN', 'EACCES']) {
        const mock = failRead(t, codesPath, errno);
        assert.throws(() => quota.getAllStorageCodes(), StoreUnavailableError, errno);
        assert.throws(() => quota.generateStorageCodes(1, 10, 'admin'), StoreUnavailableError);
        assert.throws(() => quota.deleteStorageCode(code.code), StoreUnavailableError);
        assert.throws(() => quota.useStorageCode(code.code, 'alice'), StoreUnavailableError);
        mock.mock.restore();
    }
    assert.equal(fs.readFileSync(codesPath, 'utf8'), before, 'never overwritten');
    assert.equal(meta.getUserMeta('alice').storageLimitMiB, 100, 'limit unchanged');

    fs.writeFileSync(codesPath, '[{"code": ');
    assert.equal(quota.getAllStorageCodes().length, 1, 'recovered from .bak');
    assert.ok(fs.readdirSync(stcDir).some(f => f.startsWith('storage-codes.json.corrupt-')), 'broken file kept');
});

test('storage codes: metadata unavailable -> the code is not consumed', (t) => {
    quiet(t);
    const [code] = quota.generateStorageCodes(1, 20, 'admin');
    meta.invalidateCache();
    failRead(t, metaPath, 'EIO');
    assert.throws(() => quota.useStorageCode(code.code, 'alice'), StoreUnavailableError);
    assert.equal(quota.getAllStorageCodes()[0].used, false);
});

test('storage codes: the limit cannot be saved after the code was used -> persisted: false, logged with user and code, retried', (t) => {
    const errors = [];
    quiet(t);
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    meta.setUserMeta('carol', { storageLimitMiB: 100 }, { immediate: true });
    const [code] = quota.generateStorageCodes(1, 30, 'admin');
    const original = fs.renameSync;
    const rename = t.mock.method(fs, 'renameSync', function (from, to, ...rest) {
        if (String(to) === metaPath) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
        return original.call(this, from, to, ...rest);
    });
    const result = quota.useStorageCode(code.code, 'carol');
    assert.equal(result.success, true);
    assert.equal(result.persisted, false);
    assert.equal(result.newLimitMiB, 130);
    assert.equal(quota.getAllStorageCodes().find(c => c.code === code.code).used, true);
    assert.ok(errors.some(e => e.includes(code.code) && e.includes('"carol"') && e.includes('30 MiB')), errors.join('\n'));
    assert.equal(meta.getUserMeta('carol').storageLimitMiB, 130, 'in memory');
    assert.equal(meta.getMetadataFlushState().pending, 'real', 'retried later');
    rename.mock.restore();
    assert.equal(meta.flushMetadata(), true);
    assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).carol.storageLimitMiB, 130);
    const ok = quota.useStorageCode(quota.generateStorageCodes(1, 1, 'admin')[0].code, 'carol');
    assert.equal(ok.persisted, undefined, 'unchanged response shape when saved');
});

test('storage codes / check-in over HTTP: store errors answer 503 STORE_UNAVAILABLE', async (t) => {
    quiet(t);
    const base = await serve(t);
    const created = await call(`${base}/api/stc/user-storage/generate-codes`, { count: 1, amountMiB: 25 });
    assert.equal(created.status, 200);
    const [code] = created.body.codes;
    assert.equal((await call(`${base}/api/stc/user-storage/codes`)).body.length, 1);

    const expected = { error: '数据存储暂时不可用，请稍后重试', code: 'STORE_UNAVAILABLE' };
    const mock = failRead(t, codesPath, 'EIO');
    for (const [url, body] of [
        ['/api/stc/user-storage/codes', undefined],
        ['/api/stc/user-storage/generate-codes', { count: 1, amountMiB: 5 }],
        ['/api/stc/user-storage/delete-code', { code: code.code }],
        ['/api/stc/users/use-storage-code', { code: code.code }],
    ]) {
        const response = await call(base + url, body);
        assert.equal(response.status, 503, url);
        assert.deepEqual(response.body, expected, url);
    }
    mock.mock.restore();

    // Metadata unavailable: check-in, redeeming and the admin limit change answer 503
    meta.invalidateCache();
    const metaMock = failRead(t, metaPath, 'EIO');
    for (const [url, body] of [
        ['/api/stc/users/check-in', {}],
        ['/api/stc/users/use-storage-code', { code: code.code }],
        ['/api/stc/user-storage/set-limit', { handle: 'alice', limitMiB: 1 }],
        ['/api/stc/user-storage/all-users', undefined],
    ]) {
        const response = await call(base + url, body);
        assert.equal(response.status, 503, url);
        assert.equal(response.body.code, 'STORE_UNAVAILABLE', url);
    }
    metaMock.mock.restore();
    meta.invalidateCache();

    assert.equal(quota.getAllStorageCodes()[0].used, false, 'not consumed during the outage');
    const redeemed = await call(`${base}/api/stc/users/use-storage-code`, { code: code.code });
    assert.deepEqual(redeemed.body, { success: true, addedMiB: 25, newLimitMiB: 125 });
});

test('account deletion: nothing is removed while the data root or the metadata is unavailable', async (t) => {
    quiet(t);
    const userRoot = path.join(dataRoot, 'bob');
    fs.mkdirSync(path.join(userRoot, 'chats'), { recursive: true });
    fs.writeFileSync(path.join(userRoot, 'chats', 'a.jsonl'), '{}');
    fs.writeFileSync(metaPath, JSON.stringify({ _migrated_lastActiveAt: 1, bob: { createdAt: 1 } }));

    // Metadata unreadable
    meta.invalidateCache();
    const metaMock = failRead(t, metaPath, 'EIO');
    let result = await deleteUserWithLock('bob');
    assert.deepEqual(result, { success: false, error: '数据存储暂时不可用，请稍后重试', skipped: 'store_unavailable' });
    metaMock.mock.restore();
    meta.invalidateCache();

    // Data root mount lost (device id changed)
    let dev = 7;
    initDataRootGuard({ root: dataRoot, statSync: (p) => (p === path.parse(p).root ? { dev: 1 } : { dev: p === dataRoot ? dev : 7 }) });
    dev = 8;
    let prechecked = false;
    result = await deleteUserWithLock('bob', { precheck: () => { prechecked = true; return null; } });
    assert.equal(result.skipped, 'store_unavailable');
    assert.equal(prechecked, false, 'stops before the caller precheck');

    assert.ok(fs.existsSync(path.join(userRoot, 'chats', 'a.jsonl')), 'data directory kept');
    initDataRootGuard({ root: dataRoot });
    assert.ok(meta.getUserMeta('bob'), 'metadata kept');
});

test.after(() => {
    meta.invalidateCache();
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
