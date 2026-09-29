/**
 * STC-MOD - file-backed STC stores on read failures: privacy vault (a read error is never "vault not
 * enabled"), invitation codes, announcements (HTTP 503), default template, system monitor history
 * (never overwritten by a shorter history) and the QRole cleanup run (skipped, nothing recorded).
 * Run: node src/stc-mod/tests/stc-stores.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';

// The official modules read config.yaml at import time: point them at a temp config first.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-stores-'));
const configPath = path.join(tmpDir, 'config.yaml');
fs.writeFileSync(configPath, [
    'enableInvitationCodes: true',
    'oauth:',
    '  qrole:',
    '    requireMembership: true',
    '    expiredCleanup:',
    '      enabled: true',
    '      afterDays: 30',
    '',
].join('\n'));
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(dataRoot);
globalThis.DATA_ROOT = dataRoot;
// STC-MOD reads <cwd>/config.yaml
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { setConfigFilePath } = await import('../../util.js');
setConfigFilePath(configPath);
const { StoreUnavailableError, initDataRootGuard, isStoreUnavailableError } = await import('../services/json-store.js');
const vault = await import('../services/privacy-vault.js');
const { sendVaultError } = await import('../routes/private/privacy-vault.js');
const invitations = await import('../services/invitation-codes.js');
const meta = await import('../user-metadata.js');
const { router: announcementsPublicRouter } = await import('../routes/public/announcements-public.js');
const { router: announcementsRouter } = await import('../routes/private/announcements.js');
const template = await import('../services/default-template.js');
const monitor = await import('../services/system-monitor.js');
const cleanup = await import('../services/qrole-cleanup.js');

const stcDir = path.join(dataRoot, 'stc-mod');
const directories = { user: path.join(dataRoot, 'alice', 'user') };
const vaultDir = path.join(stcDir, 'privacy-vaults');

/**
 * Vault record file of a user (same id rule as privacy-vault.js).
 * @param {{user: string}} dirs
 * @returns {string}
 */
function vaultFile(dirs) {
    const id = crypto.createHash('sha256').update(dirs.user).digest('hex').substring(0, 16);
    return path.join(vaultDir, `vault_${id}.json`);
}

/**
 * Make one fs function fail with `code` for paths matching `match` (restored with the test).
 * @param {import('node:test').TestContext} t
 * @param {string} fn
 * @param {(p: string) => boolean} match
 * @param {string} code
 */
function failFs(t, fn, match, code = 'EIO') {
    const original = fs[fn];
    return t.mock.method(fs, fn, function (target, ...rest) {
        if (typeof target === 'string' && match(target)) {
            throw Object.assign(new Error(`${code}: injected ${fn}`), { code });
        }
        return original.call(this, target, ...rest);
    });
}

const quiet = (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'info', () => {});
};

/**
 * Response double for route helpers.
 */
function fakeRes() {
    return {
        statusCode: 200, body: undefined, headers: {}, headersSent: false,
        status(code) { this.statusCode = code; return this; },
        set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        type() { return this; },
        json(body) { this.body = body; this.headersSent = true; return this; },
        send(body) { this.body = body; this.headersSent = true; return this; },
    };
}

/**
 * Start an express app with the given routers, return its base URL.
 * @param {import('node:test').TestContext} t
 * @param {(app: import('express').Express) => void} mount
 */
async function serve(t, mount) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { profile: { handle: 'admin', admin: true } };
        next();
    });
    mount(app);
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise(resolve => server.once('listening', resolve));
    return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

test.beforeEach(() => {
    initDataRootGuard({ root: dataRoot });
});

// ---------------------------------------------------------------------------
// Privacy vault
// ---------------------------------------------------------------------------

test('vault: missing record = not enabled; enable creates it (never replacing an existing one)', (t) => {
    quiet(t);
    fs.rmSync(vaultDir, { recursive: true, force: true });
    assert.equal(vault.getVaultStatus(directories).enabled, false);
    assert.equal(vault.initializeVault(directories, 'passphrase-1'), true);
    assert.equal(vault.getVaultStatus(directories).enabled, true);
    const [file] = fs.readdirSync(vaultDir);
    const before = fs.readFileSync(path.join(vaultDir, file), 'utf8');
    assert.equal(vault.initializeVault(directories, 'passphrase-2'), false);
    assert.equal(fs.readFileSync(path.join(vaultDir, file), 'utf8'), before);
    vault.lockVault(directories);
    assert.equal(vault.unlockVault(directories, 'passphrase-1'), true);
});

test('vault: a read error is never "not enabled" (status / unlock / enable / reset fail, record untouched)', (t) => {
    quiet(t);
    const file = vaultFile(directories);
    const before = fs.readFileSync(file, 'utf8');
    for (const code of ['EIO', 'ENOTCONN', 'EACCES']) {
        const mock = failFs(t, 'readFileSync', p => p === file, code);
        assert.throws(() => vault.getVaultStatus(directories), StoreUnavailableError, code);
        assert.throws(() => vault.unlockVault(directories, 'passphrase-1'), StoreUnavailableError);
        assert.throws(() => vault.initializeVault(directories, 'new-passphrase'), StoreUnavailableError);
        mock.mock.restore();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'enable never overwrote the unreadable record');

    // Lost data root: reset must not report "no record" (the caller would wipe the encrypted keys)
    let dev = 7;
    initDataRootGuard({ root: dataRoot, statSync: (p) => (p === path.parse(p).root ? { dev: 1 } : { dev: p === dataRoot ? dev : 7 }) });
    dev = 8;
    assert.throws(() => vault.getVaultStatus(directories), StoreUnavailableError);
    assert.throws(() => vault.resetVault(directories), StoreUnavailableError);
    assert.equal(fs.existsSync(file), true);

    // HTTP mapping of the vault routes
    const res = fakeRes();
    sendVaultError({ originalUrl: '/api/stc/privacy-vault/status' }, res, new StoreUnavailableError('test'));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: '数据存储暂时不可用，请稍后重试', code: 'STORE_UNAVAILABLE' });
});

test('vault: record path is a directory (EISDIR) -> unavailable', (t) => {
    quiet(t);
    const carol = { user: path.join(dataRoot, 'carol', 'user') };
    const file = vaultFile(carol);
    fs.mkdirSync(file, { recursive: true });
    assert.throws(() => vault.getVaultStatus(carol), StoreUnavailableError);
    assert.throws(() => vault.initializeVault(carol, 'x'.repeat(8)), StoreUnavailableError);
    assert.equal(fs.statSync(file).isDirectory(), true);
    fs.rmdirSync(file);
});

test('vault: corrupt record -> VaultRecordCorruptError (not "not enabled"), kept; reset is the way out', (t) => {
    quiet(t);
    const dave = { user: path.join(dataRoot, 'dave', 'user') };
    vault.initializeVault(dave, 'passphrase-d');
    vault.lockVault(dave);
    const daveFile = vaultFile(dave);
    fs.writeFileSync(daveFile, '{ "salt": ');
    assert.throws(() => vault.getVaultStatus(dave), vault.VaultRecordCorruptError);
    assert.throws(() => vault.unlockVault(dave, 'passphrase-d'), vault.VaultRecordCorruptError);
    assert.throws(() => vault.initializeVault(dave, 'passphrase-new'), vault.VaultRecordCorruptError);
    assert.equal(fs.readFileSync(daveFile, 'utf8'), '{ "salt": ', 'not overwritten');
    assert.ok(fs.readdirSync(vaultDir).some(f => f.startsWith(`${path.basename(daveFile)}.corrupt-`)), 'copy kept');

    const res = fakeRes();
    sendVaultError({ originalUrl: '/api/stc/privacy-vault/status' }, res, new vault.VaultRecordCorruptError());
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'VAULT_RECORD_CORRUPT');

    assert.deepEqual(vault.resetVault(dave), { existed: true });
    assert.equal(vault.getVaultStatus(dave).enabled, false);
    assert.deepEqual(vault.resetVault(dave), { existed: false });
});

// ---------------------------------------------------------------------------
// Invitation codes
// ---------------------------------------------------------------------------

test('invitation codes: missing = none; read error throws (no empty list, nothing consumed or created)', (t) => {
    quiet(t);
    const file = path.join(stcDir, 'invitation-codes.json');
    fs.rmSync(file, { force: true });
    assert.deepEqual(invitations.getAllInvitationCodes(), []);
    const created = invitations.createInvitationCode('admin', '1week');
    assert.equal(invitations.validateInvitationCode(created.code).valid, true);
    const before = fs.readFileSync(file, 'utf8');

    const mock = failFs(t, 'readFileSync', p => p === file, 'EIO');
    assert.throws(() => invitations.getAllInvitationCodes(), isStoreUnavailableError);
    assert.throws(() => invitations.validateInvitationCode(created.code), isStoreUnavailableError);
    assert.throws(() => invitations.createInvitationCode('admin'), isStoreUnavailableError);
    assert.throws(() => invitations.deleteInvitationCode(created.code), isStoreUnavailableError);
    meta.setUserMeta('erin', { createdAt: 1, expiresAt: Date.now() + 1000 });
    const erinBefore = meta.getUserMeta('erin').expiresAt;
    assert.throws(() => invitations.useInvitationCode(created.code, 'erin'), isStoreUnavailableError);
    assert.equal(meta.getUserMeta('erin').expiresAt, erinBefore, 'expiry not extended without consuming the code');
    mock.mock.restore();
    assert.equal(fs.readFileSync(file, 'utf8'), before);

    const used = invitations.useInvitationCode(created.code, 'erin');
    assert.equal(used.success, true);
    assert.equal(meta.getUserMeta('erin').expiresAt, used.expiresAt);
    assert.equal(used.expiresAt, erinBefore + 7 * 86400000, 'a running expiry is extended');
    assert.equal(invitations.useInvitationCode(created.code, 'erin').reason, '邀请码已被使用');
    assert.equal(invitations.deleteInvitationCode(created.code), true);
    assert.equal(invitations.deleteInvitationCode(created.code), false);
});

test('invitation codes: corrupt file starts empty and is kept as .corrupt-*', (t) => {
    quiet(t);
    const file = path.join(stcDir, 'invitation-codes.json');
    fs.rmSync(`${file}.bak`, { force: true });
    fs.writeFileSync(file, '[{"code":');
    assert.deepEqual(invitations.getAllInvitationCodes(), []);
    assert.ok(fs.readdirSync(stcDir).some(f => f.startsWith('invitation-codes.json.corrupt-')));
});

// ---------------------------------------------------------------------------
// Announcements (routes)
// ---------------------------------------------------------------------------

test('announcements: 503 STORE_UNAVAILABLE on read errors (public and admin), [] when missing', async (t) => {
    quiet(t);
    const base = await serve(t, (app) => {
        app.use('/api/stc/announcements', announcementsPublicRouter);
        app.use('/api/stc/announcements', announcementsRouter);
    });
    const dir = path.join(stcDir, 'announcements');
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(await (await fetch(`${base}/api/stc/announcements/login/current`)).json(), []);
    const created = await fetch(`${base}/api/stc/announcements/create?type=login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'T', content: 'C' }),
    });
    assert.equal(created.status, 200);
    assert.equal((await (await fetch(`${base}/api/stc/announcements/login/current`)).json()).length, 1);

    const loginFile = path.join(dir, 'login_announcements.json');
    const mock = failFs(t, 'readFileSync', p => p === loginFile, 'ENOTCONN');
    for (const [url, init] of [
        ['/api/stc/announcements/login/current', undefined],
        ['/api/stc/announcements/list?type=login', undefined],
        ['/api/stc/announcements/create?type=login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
        ['/api/stc/announcements/delete?type=login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"x"}' }],
    ]) {
        const res = await fetch(base + url, init);
        assert.equal(res.status, 503, url);
        assert.deepEqual(await res.json(), { error: '数据存储暂时不可用，请稍后重试', code: 'STORE_UNAVAILABLE' });
    }
    mock.mock.restore();
    assert.equal(JSON.parse(fs.readFileSync(loginFile, 'utf8')).length, 1, 'nothing overwritten');
});

// ---------------------------------------------------------------------------
// Default template
// ---------------------------------------------------------------------------

test('default template: missing = no template; unreadable -> throws (never "no template")', (t) => {
    quiet(t);
    const metaFile = path.join(stcDir, 'default-template', 'template-meta.json');
    fs.rmSync(path.dirname(metaFile), { recursive: true, force: true });
    assert.equal(template.getTemplateMeta(), null);
    assert.equal(fs.existsSync(path.dirname(metaFile)), false, 'reading does not create the directory');
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify({ sourceHandle: 'alice' }));
    assert.equal(template.getTemplateMeta().sourceHandle, 'alice');
    const mock = failFs(t, 'readFileSync', p => p === metaFile, 'EIO');
    assert.throws(() => template.getTemplateMeta(), isStoreUnavailableError);
    mock.mock.restore();
    assert.equal(template.deleteTemplate(), true);
    assert.equal(template.getTemplateMeta(), null);
});

// ---------------------------------------------------------------------------
// System monitor history
// ---------------------------------------------------------------------------

test('monitor history: never overwritten with a shorter history after a failed read; merged once readable', (t) => {
    quiet(t);
    const file = monitor.getHistoryPath();
    const stored = Array.from({ length: 5 }, (_, i) => ({ timestamp: i + 1, cpu: 1 }));
    fs.writeFileSync(file, JSON.stringify(stored));
    const writes = t.mock.method(fs, 'renameSync');

    const mock = failFs(t, 'readFileSync', p => p === file, 'EIO');
    monitor.recordSnapshot();
    monitor.recordSnapshot();
    assert.equal(writes.mock.calls.filter(c => c.arguments[1] === file).length, 0, 'nothing written');
    assert.throws(() => monitor.loadHistory(), isStoreUnavailableError);
    mock.mock.restore();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), stored);

    monitor.recordSnapshot();
    const history = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(history.length, 8, 'stored points + the 2 kept in memory + the new one');
    assert.deepEqual(history.slice(0, 5), stored);
    assert.equal(monitor.loadHistory().length, 8);

    // Once loaded, a later read error does not matter (memory is the source of truth)
    const again = failFs(t, 'readFileSync', p => p === file, 'EIO');
    assert.equal(monitor.loadHistory().length, 8);
    again.mock.restore();
});

// ---------------------------------------------------------------------------
// QRole cleanup
// ---------------------------------------------------------------------------

test('qrole cleanup: skipped (throws, nothing recorded) while its state file or the data root is unavailable', async (t) => {
    quiet(t);
    const stateFile = path.join(stcDir, 'qrole-cleanup-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ lastRunAt: 1, lastResult: null }));
    const mock = failFs(t, 'readFileSync', p => p === stateFile, 'EIO');
    await assert.rejects(cleanup.runQroleCleanup({ trigger: 'manual' }), isStoreUnavailableError);
    assert.throws(() => cleanup.readCleanupState(), isStoreUnavailableError);
    mock.mock.restore();
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { lastRunAt: 1, lastResult: null }, 'state not rewritten');
    assert.equal(cleanup.getQroleCleanupStatus().running, false);

    let dev = 7;
    initDataRootGuard({ root: dataRoot, statSync: (p) => (p === path.parse(p).root ? { dev: 1 } : { dev: p === dataRoot ? dev : 7 }) });
    dev = 8;
    await assert.rejects(cleanup.runQroleCleanup({ trigger: 'scheduler' }), isStoreUnavailableError);
    dev = 7;

    // Healthy: the run happens and is recorded
    const run = await cleanup.runQroleCleanup({ trigger: 'manual' });
    assert.equal(run.started, true);
    assert.equal(run.result.error, undefined);
    assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastRunAt > 1);
});

test.after(() => {
    meta.invalidateCache();
    monitor.stopMonitoring();
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
