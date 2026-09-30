/**
 * Tests: requests that change data never reach the official handlers while the data root is
 * unavailable (middleware/data-root-write-guard.js and the store-error path of
 * middleware/storage-enforce.js).
 * Run: node src/stc-mod/tests/data-root-write-guard.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The official modules read config.yaml at import time and STC-MOD reads <cwd>/config.yaml:
// point both at a temp config (quota on) and a temp data root.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-write-guard-'));
const configPath = path.join(tmpDir, 'config.yaml');
fs.writeFileSync(configPath, 'skipContentCheck: true\nuserStorage:\n  enabled: true\n  defaultLimitMiB: 1\n  dailyCheckInMiB: 0\n');
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(dataRoot);
globalThis.DATA_ROOT = dataRoot;
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { setConfigFilePath } = await import('../../util.js');
setConfigFilePath(configPath);
const { StoreUnavailableError, initDataRootGuard } = await import('../services/json-store.js');
const { createDataRootWriteGuard, isGuardedRequest, useRightAfter } = await import('../middleware/data-root-write-guard.js');
const { default: express } = await import('express');
const { createStorageEnforceMiddleware } = await import('../middleware/storage-enforce.js');

test.after(() => {
    initDataRootGuard({ root: dataRoot });
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Fake Express response (enough for sendStoreUnavailable and the quota middleware). */
function fakeRes() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headersSent = false;
    res.headers = {};
    res.body = undefined;
    res.set = (name, value) => {
        res.headers[String(name).toLowerCase()] = value;
        return res;
    };
    res.type = (value) => res.set('content-type', value);
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
        res.headersSent = true;
        return res;
    };
    res.send = (body) => {
        res.body = body;
        res.headersSent = true;
        return res;
    };
    return res;
}

/**
 * Run a middleware once.
 * @param {import('express').RequestHandler} mw
 * @param {object} req
 */
async function run(mw, req) {
    const res = fakeRes();
    let nextCalled = false;
    await mw({ headers: { accept: 'application/json' }, ...req }, res, () => { nextCalled = true; });
    return { res, nextCalled };
}

const unavailable = () => {
    throw new StoreUnavailableError('test: data root lost');
};

test('isGuardedRequest: every data-changing method on any path, except logout', () => {
    for (const method of ['POST', 'put', 'PATCH', 'DELETE']) {
        assert.equal(isGuardedRequest(method, '/api/chats/save'), true, method);
    }
    assert.equal(isGuardedRequest('POST', '//api//settings/save'), true);
    assert.equal(isGuardedRequest('POST', '/API/users/login'), true);
    // multer stores multipart bodies of any path (deprecated redirects, unknown paths) under the data root
    assert.equal(isGuardedRequest('POST', '/importcharacter'), true);
    assert.equal(isGuardedRequest('POST', '/apix/save'), true);
    assert.equal(isGuardedRequest('GET', '/api/chats/save'), false);
    assert.equal(isGuardedRequest('HEAD', '/api/ping'), false);
    assert.equal(isGuardedRequest('OPTIONS', '/api/chats/save'), false);
    // Logout only clears the cookie session
    assert.equal(isGuardedRequest('POST', '/api/users/logout'), false);
    assert.equal(isGuardedRequest('POST', '/API/Users/Logout/'), false);
});

test('useRightAfter: the guard runs after the marker middleware and before the routers registered later', async () => {
    const app = express();
    const originalUse = app.use;
    const order = [];
    const marker = (req, res, next) => { order.push('marker'); next(); };
    const guard = (req, res, next) => { order.push('guard'); next(); };
    const placement = useRightAfter(app, marker, guard);
    assert.notEqual(app.use, originalUse, 'wrapped until the marker comes');
    app.use((req, res, next) => { order.push('before'); next(); });
    assert.equal(placement.installed(), false);
    app.use(marker);
    assert.equal(placement.installed(), true);
    assert.equal(app.use, originalUse, 'app.use restored');
    app.post('/api/x', (req, res) => { order.push('handler'); res.sendStatus(204); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/x`, { method: 'POST' });
        assert.equal(response.status, 204);
        assert.deepEqual(order, ['before', 'marker', 'guard', 'handler']);
    } finally {
        server.close();
    }
});

test('useRightAfter: restore() undoes the wrapper when the marker never comes', () => {
    const app = express();
    const originalUse = app.use;
    const placement = useRightAfter(app, () => {}, () => {});
    assert.notEqual(app.use, originalUse);
    placement.restore();
    assert.equal(app.use, originalUse);
    assert.equal(placement.installed(), false);
    // A plain object whose use() comes from its prototype gets the prototype method back
    const proto = { use() { return 'proto'; } };
    const plain = Object.create(proto);
    useRightAfter(plain, () => {}, () => {}).restore();
    assert.equal(Object.prototype.hasOwnProperty.call(plain, 'use'), false);
    assert.equal(plain.use(), 'proto');
});

test('write guard: 503 STORE_UNAVAILABLE and the handler is never reached while the data root is unavailable', async () => {
    const guard = createDataRootWriteGuard({ assertAvailable: unavailable });
    for (const [method, p] of [['POST', '/api/chats/save'], ['POST', '/api/settings/save'], ['DELETE', '/api/x'], ['POST', '/api/stc/users/register']]) {
        const { res, nextCalled } = await run(guard, { method, path: p });
        assert.equal(nextCalled, false, `${method} ${p} must not reach the handler`);
        assert.equal(res.statusCode, 503);
        assert.equal(res.body?.code, 'STORE_UNAVAILABLE');
        assert.equal(res.headers['retry-after'], '30');
    }
    // Reads are not affected
    const read = await run(guard, { method: 'GET', path: '/api/characters/all' });
    assert.equal(read.nextCalled, true);
});

test('write guard: JSON 503 for API requests also inside mounted routers and for absolute-form targets; text for pages', async () => {
    const guard = createDataRootWriteGuard({ assertAvailable: unavailable });
    const cases = [
        { originalUrl: '/api/stc/announcements/list', path: '/list', json: true },
        { originalUrl: 'http://example.test/api/chats/save', path: '/api/chats/save', json: true },
        { originalUrl: '/importcharacter', path: '/importcharacter', json: false },
    ];
    for (const { originalUrl, path: p, json } of cases) {
        const res = fakeRes();
        await guard({ method: 'POST', originalUrl, url: originalUrl, path: p, headers: { accept: 'text/html' } }, res, () => assert.fail('must not reach the handler'));
        assert.equal(res.statusCode, 503, originalUrl);
        assert.equal(typeof res.body === 'object', json, originalUrl);
    }
});

test('write guard: passes when available; an unexpected guard error does not take the API down', async () => {
    let calls = 0;
    const ok = await run(createDataRootWriteGuard({ assertAvailable: () => { calls++; } }), { method: 'POST', path: '/api/chats/save' });
    assert.equal(ok.nextCalled, true);
    assert.equal(calls, 1);
    const originalError = console.error;
    console.error = () => {};
    try {
        const odd = await run(createDataRootWriteGuard({ assertAvailable: () => { throw new Error('boom'); } }), { method: 'POST', path: '/api/chats/save' });
        assert.equal(odd.nextCalled, true);
    } finally {
        console.error = originalError;
    }
});

test('write guard (real json-store guard): a lost mount (device changed) is refused with 503', async () => {
    const originalError = console.error;
    console.error = () => {};
    let lost = false;
    try {
        // Pretend the data root was a mount with device 4242 at startup, then lose it
        initDataRootGuard({
            root: dataRoot,
            statSync: p => ({ dev: path.resolve(p) === path.resolve(dataRoot) && !lost ? 4242 : fs.statSync(p).dev }),
        });
        const guard = createDataRootWriteGuard();
        assert.equal((await run(guard, { method: 'POST', path: '/api/chats/save' })).nextCalled, true, 'mount present');
        lost = true;
        const refused = await run(guard, { method: 'POST', path: '/api/chats/save' });
        assert.equal(refused.nextCalled, false);
        assert.equal(refused.res.statusCode, 503);
        assert.equal(refused.res.body?.code, 'STORE_UNAVAILABLE');
    } finally {
        console.error = originalError;
        initDataRootGuard({ root: dataRoot });
    }
});

/**
 * Quota middleware with fake dependencies.
 * @param {object} extra
 */
function quotaMiddleware(extra = {}) {
    const warnings = [];
    const mw = createStorageEnforceMiddleware({
        isEnabled: () => true,
        getStorageInfo: async () => ({ enabled: true, canWrite: true, usedMiB: 0, limitMiB: 1, percent: 0 }),
        onWrite: () => {},
        onFree: () => {},
        logger: { warn: (...args) => warnings.push(args.join(' ')) },
        ...extra,
    });
    return { mw, warnings };
}

const user = { session: { handle: 'alice' }, user: { profile: { handle: 'alice' } } };

test('quota middleware: a store error is answered with 503 instead of letting the write through', async () => {
    const { mw } = quotaMiddleware({ getStorageInfo: async () => { throw new StoreUnavailableError('metadata unreadable'); } });
    const { res, nextCalled } = await run(mw, { ...user, method: 'POST', path: '/api/chats/save', body: {} });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body?.code, 'STORE_UNAVAILABLE');
});

test('quota middleware: an unavailable data root refuses writes and deletions even when usage looks fine', async () => {
    const { mw } = quotaMiddleware({ assertAvailable: unavailable });
    for (const p of ['/api/chats/save', '/api/files/upload', '/api/chats/delete', '/api/backgrounds/rename']) {
        const { res, nextCalled } = await run(mw, { ...user, method: 'POST', path: p, body: {} });
        assert.equal(nextCalled, false, p);
        assert.equal(res.statusCode, 503, p);
    }
    // Requests the quota does not care about are left to the write guard / the routers
    const other = await run(mw, { ...user, method: 'POST', path: '/api/settings/get', body: {} });
    assert.equal(other.nextCalled, true);
});

test('quota middleware: a mount lost while waiting for the usage count is caught before the handler', async () => {
    let checks = 0;
    const { mw } = quotaMiddleware({
        assertAvailable: () => {
            checks++;
            if (checks > 1) throw new StoreUnavailableError('lost during the wait');
        },
        getStorageInfo: async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
            return { enabled: true, canWrite: true, usedMiB: 0, limitMiB: 1, percent: 0 };
        },
    });
    const { res, nextCalled } = await run(mw, { ...user, method: 'POST', path: '/api/chats/save', body: {} });
    assert.equal(checks, 2, 'checked before and after the wait');
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
});

test('quota middleware: other internal errors still never lock users out', async () => {
    const { mw, warnings } = quotaMiddleware({ getStorageInfo: async () => { throw new Error('unexpected'); } });
    const { res, nextCalled } = await run(mw, { ...user, method: 'POST', path: '/api/chats/save', body: {} });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(warnings.length, 1);
});
