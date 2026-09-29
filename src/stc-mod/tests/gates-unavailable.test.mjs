/**
 * STC-MOD - request gates while the user metadata cannot be read: the QRole session guard and the
 * expiration check fail closed with 503 STORE_UNAVAILABLE (admins and switched-off features excepted).
 * Run: node src/stc-mod/tests/gates-unavailable.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-gates-unavailable-'));
const configPath = path.join(tmpDir, 'config.yaml');
const writeConfig = ({ requireMembership = true, invitations = true } = {}) => fs.writeFileSync(configPath, [
    `enableInvitationCodes: ${invitations}`,
    'oauth:',
    '  qrole:',
    `    requireMembership: ${requireMembership}`,
    '',
].join('\n'));
writeConfig();
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(path.join(dataRoot, 'stc-mod'), { recursive: true });
globalThis.DATA_ROOT = dataRoot;
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { setConfigFilePath } = await import('../../util.js');
setConfigFilePath(configPath);
const meta = await import('../user-metadata.js');
const { initDataRootGuard } = await import('../services/json-store.js');
const { qroleSessionGuard } = await import('../services/qrole-session.js');
const { expirationCheckMiddleware } = await import('../middleware/expiration-check.js');

const metaPath = path.join(dataRoot, 'stc-mod', 'user-metadata.json');
fs.writeFileSync(metaPath, JSON.stringify({ _migrated_lastActiveAt: 1, bob: { createdAt: 1, expiresAt: 0 } }));

function fakeRes() {
    return {
        statusCode: 200, body: undefined, headersSent: false,
        status(code) { this.statusCode = code; return this; },
        set() { return this; },
        type() { return this; },
        json(body) { this.body = body; this.headersSent = true; return this; },
        send(body) { this.body = body; this.headersSent = true; return this; },
        redirect(url) { this.redirected = url; this.headersSent = true; return this; },
    };
}

/**
 * Run a middleware; resolves with { res, nextCalls }.
 * @param {Function} middleware
 * @param {object} req
 */
async function run(middleware, req) {
    const res = fakeRes();
    let nextCalls = 0;
    await middleware(req, res, () => { nextCalls++; });
    return { res, nextCalls };
}

const userReq = (url, admin = false) => ({
    path: url, originalUrl: url, method: 'GET', headers: {},
    user: { profile: { handle: 'bob', admin, created: 1 } },
    session: { handle: 'bob' },
});

/**
 * Metadata unreadable (EIO) for the test.
 * @param {import('node:test').TestContext} t
 */
function metadataUnreadable(t) {
    for (const level of ['error', 'warn', 'log']) t.mock.method(console, level, () => {});
    meta.invalidateCache();
    const original = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function (file, ...rest) {
        if (String(file) === metaPath) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
        return original.call(this, file, ...rest);
    });
}

test.beforeEach(() => {
    initDataRootGuard({ root: dataRoot });
    writeConfig();
});

test('QRole session guard: metadata unavailable -> 503 (fail closed), session kept', async (t) => {
    metadataUnreadable(t);
    for (const url of ['/api/chats/save', '/']) {
        const req = userReq(url);
        const { res, nextCalls } = await run(qroleSessionGuard, req);
        assert.equal(nextCalls, 0, url);
        assert.equal(res.statusCode, 503, url);
        assert.deepEqual(req.session, { handle: 'bob' }, 'not logged out because of an outage');
    }
    const api = await run(qroleSessionGuard, userReq('/api/chats/save'));
    assert.deepEqual(api.res.body, { error: '数据存储暂时不可用，请稍后重试', code: 'STORE_UNAVAILABLE' });
});

test('QRole session guard: exceptions without metadata (admin, membership gate off, anonymous)', async (t) => {
    metadataUnreadable(t);
    assert.equal((await run(qroleSessionGuard, userReq('/api/x', true))).nextCalls, 1, 'admin');
    assert.equal((await run(qroleSessionGuard, { path: '/api/x', headers: {} })).nextCalls, 1, 'not logged in');
    writeConfig({ requireMembership: false });
    assert.equal((await run(qroleSessionGuard, userReq('/api/x'))).nextCalls, 1, 'requireMembership off');
});

test('expiration check: metadata unavailable -> 503 for non-admins; no check when invitations are off', async (t) => {
    metadataUnreadable(t);
    const { res, nextCalls } = await run(expirationCheckMiddleware, userReq('/api/stc/users/me-ext'));
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'STORE_UNAVAILABLE');
    assert.equal((await run(expirationCheckMiddleware, userReq('/api/stc/users/me-ext', true))).nextCalls, 1, 'admin');
    writeConfig({ invitations: false });
    assert.equal((await run(expirationCheckMiddleware, userReq('/api/stc/users/me-ext'))).nextCalls, 1, 'feature off');
});

test('readable metadata: both gates let a permanent non-QRole account through', async () => {
    meta.invalidateCache();
    assert.equal((await run(qroleSessionGuard, userReq('/api/x'))).nextCalls, 1);
    const checked = await run(expirationCheckMiddleware, userReq('/api/stc/x'));
    assert.equal(checked.nextCalls, 1);
});

test.after(() => {
    meta.invalidateCache();
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
