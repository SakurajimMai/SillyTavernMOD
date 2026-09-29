/**
 * STC-MOD - account creation while the user metadata cannot be read: no official record is created
 * (so no second account for an OAuth identity whose link just cannot be read, and no account without
 * metadata). Uses a temp node-persist storage, no server.
 * Run: node src/stc-mod/tests/register-unavailable.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-register-unavailable-'));
const configPath = path.join(tmpDir, 'config.yaml');
fs.writeFileSync(configPath, 'skipContentCheck: true\n');
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(dataRoot);
globalThis.DATA_ROOT = dataRoot;
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { setConfigFilePath } = await import('../../util.js');
setConfigFilePath(configPath);
const storage = (await import('node-persist')).default;
await storage.init({ dir: path.join(dataRoot, '_storage') });
const { toKey, getAllUserHandles } = await import('../../users.js');
const meta = await import('../user-metadata.js');
const { initDataRootGuard, isStoreUnavailableError } = await import('../services/json-store.js');
const { createOAuthUser, createUser, isAccountRecordGone } = await import('../routes/public/register-helper.js');
const { resolveLinkedAccount } = await import('../routes/public/oauth.js');

const metaPath = path.join(dataRoot, 'stc-mod', 'user-metadata.json');

/**
 * Metadata reads fail with EIO (first load) for the duration of the test.
 * @param {import('node:test').TestContext} t
 */
function metadataUnreadable(t) {
    const original = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function (file, ...rest) {
        if (String(file) === metaPath) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
        return original.call(this, file, ...rest);
    });
}

const quiet = (t) => {
    for (const level of ['error', 'warn', 'log', 'info']) t.mock.method(console, level, () => {});
};

test.beforeEach(() => {
    initDataRootGuard({ root: dataRoot });
    meta.invalidateCache();
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({
        _migrated_lastActiveAt: 1,
        linked: { oauthProvider: 'qrole', oauthUserId: 'q-42', createdAt: 1 },
    }));
});

test('OAuth: links unreadable -> StoreUnavailableError, no second account for the identity', async (t) => {
    quiet(t);
    metadataUnreadable(t);
    const before = await getAllUserHandles();
    await assert.rejects(createOAuthUser({ provider: 'qrole', id: 'q-42', username: 'someone' }), isStoreUnavailableError);
    assert.deepEqual(await getAllUserHandles(), before, 'no official record created');
    assert.equal(await storage.getItem(toKey('someone')), undefined);
});

test('OAuth: readable links -> the linked identity is a conflict, a new one gets an account', async (t) => {
    quiet(t);
    const linked = await createOAuthUser({ provider: 'qrole', id: 'q-42', username: 'someone' });
    assert.deepEqual(linked, { success: false, error: '该第三方账号已绑定其他账户', conflict: true });
    const created = await createOAuthUser({ provider: 'qrole', id: 'q-43', username: 'newbie' });
    assert.equal(created.success, true);
    assert.equal(meta.findUserByOAuth('qrole', 'q-43'), created.handle);
});

test('local registration: metadata unreadable -> refused before the record is created', async (t) => {
    quiet(t);
    metadataUnreadable(t);
    const result = await createUser('fresh-user', 'Fresh', 'password-123');
    assert.deepEqual(result, { success: false, error: '数据存储暂时不可用，请稍后重试', unavailable: true });
    assert.equal(await storage.getItem(toKey('fresh-user')), undefined);
});

/**
 * Guard with an injected stat: the data root is a mount (dev 7) until `lose()` is called.
 */
function mountedGuard() {
    let dev = 7;
    initDataRootGuard({
        root: dataRoot,
        statSync: (p) => {
            if (p === path.parse(p).root) return { dev: 1 };
            if (p === dataRoot) return { dev };
            return { dev: p.startsWith(dataRoot) ? 7 : 1 };
        },
    });
    return { lose: () => { dev = 99; }, back: () => { dev = 7; } };
}

test('isAccountRecordGone: true only for a record confirmed missing with a usable data root', async (t) => {
    quiet(t);
    await storage.setItem(toKey('present'), { handle: 'present', created: 1 });
    assert.equal(await isAccountRecordGone('present'), false);
    assert.equal(await isAccountRecordGone('absent'), true);

    const guard = mountedGuard();
    guard.lose();
    await assert.rejects(isAccountRecordGone('absent'), isStoreUnavailableError, 'a lost mount is not a deleted account');
    guard.back();

    const recordDir = path.join(dataRoot, '_storage');
    fs.renameSync(recordDir, `${recordDir}.moved`);
    try {
        await assert.rejects(isAccountRecordGone('absent'), isStoreUnavailableError, 'no record directory: not "missing"');
    } finally {
        fs.renameSync(`${recordDir}.moved`, recordDir);
    }
});

test('OAuth: a mount lost while the free handle is looked up -> nothing created, the existing metadata of the handle kept', async (t) => {
    quiet(t);
    meta.setUserMeta('taken', { oauthProvider: 'github', oauthUserId: 'g-1', createdAt: 5 }, { immediate: true });
    const guard = mountedGuard();
    const originalKeys = storage.keys.bind(storage);
    t.mock.method(storage, 'keys', async (...args) => {
        // The mount vanishes during the lookup: every record now reads as missing
        guard.lose();
        return (await originalKeys(...args)).filter(() => false);
    });
    const before = (await originalKeys()).slice().sort();
    await assert.rejects(createOAuthUser({ provider: 'qrole', id: 'q-77', username: 'taken' }), isStoreUnavailableError);
    guard.back();
    t.mock.restoreAll();
    assert.deepEqual((await storage.keys()).slice().sort(), before, 'no official record written');
    assert.equal(meta.getUserMeta('taken')?.oauthUserId, 'g-1', 'metadata of the handle not dropped');

    // Local registration: the same lost mount during the lookup -> 503 text, no record
    const guard2 = mountedGuard();
    t.mock.method(storage, 'keys', async (...args) => {
        guard2.lose();
        return originalKeys(...args);
    });
    const local = await createUser('another', 'Another', 'password-123');
    guard2.back();
    t.mock.restoreAll();
    assert.deepEqual(local, { success: false, error: '数据存储暂时不可用，请稍后重试', unavailable: true });
    assert.equal(await storage.getItem(toKey('another')), undefined);
});

test('OAuth login: a link whose account record is missing only because the mount is gone is kept (no second account later)', async (t) => {
    quiet(t);
    const created = await createOAuthUser({ provider: 'github', id: 'g-500', username: 'linkeduser' });
    assert.equal(created.success, true);
    const handle = created.handle;
    assert.equal((await resolveLinkedAccount('github', 'g-500'))?.handle, handle);

    // Mount gone: node-persist reads every record as missing
    const guard = mountedGuard();
    const originalGetItem = storage.getItem.bind(storage);
    const getItem = t.mock.method(storage, 'getItem', async (key) => {
        guard.lose();
        return key === toKey(handle) ? undefined : originalGetItem(key);
    });
    await assert.rejects(resolveLinkedAccount('github', 'g-500'), isStoreUnavailableError);
    assert.equal(meta.getUserMeta(handle).oauthUserId, 'g-500', 'link kept in memory');
    getItem.mock.restore();
    guard.back(); // back with the same device id (no watchdog here: not sticky)
    assert.equal(meta.flushMetadata(), true);
    assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8'))[handle].oauthUserId, 'g-500', 'link kept on disk');
    assert.equal((await resolveLinkedAccount('github', 'g-500'))?.handle, handle, 'the next login finds the same account');

    // A record that is really gone (usable data root) is a stale link and cleared
    await storage.removeItem(toKey(handle));
    assert.equal(await resolveLinkedAccount('github', 'g-500'), null);
    assert.equal(meta.getUserMeta(handle).oauthProvider, null);
    initDataRootGuard({ root: dataRoot });
});

test.after(() => {
    meta.invalidateCache();
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
