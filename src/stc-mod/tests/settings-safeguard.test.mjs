/**
 * STC-MOD - settings.json safeguard tests (temp data root, default settings restore, no server).
 * Run: node src/stc-mod/tests/settings-safeguard.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The official modules read config.yaml at import time: point them at a temp config first.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-settings-guard-'));
const configPath = path.join(tmpDir, 'config.yaml');
fs.writeFileSync(configPath, 'skipContentCheck: true\n');
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(dataRoot);
globalThis.DATA_ROOT = dataRoot;
// STC-MOD reads <cwd>/config.yaml (newUserContent): use the temp config as well
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { setConfigFilePath } = await import('../../util.js');
setConfigFilePath(configPath);
const { getUserDirectories } = await import('../../users.js');
const { checkForNewContent } = await import('../../endpoints/content-manager.js');
const { createEnsureUserSettingsFile, ensureUserSettingsFile } = await import('../services/settings-safeguard.js');

/**
 * Run a middleware like Express does and report whether next() was called.
 * @param {import('express').RequestHandler} middleware
 * @param {object} req
 * @returns {Promise<{nextCalls: number, nextArgs: any[]}>}
 */
async function run(middleware, req) {
    let nextCalls = 0;
    let nextArgs = [];
    await middleware(req, {}, (...args) => {
        nextCalls++;
        nextArgs = args;
    });
    return { nextCalls, nextArgs };
}

function userReq(handle) {
    return { user: { profile: { handle }, directories: getUserDirectories(handle) } };
}

/** Empty user root, like the official reset leaves it (rm root + ensurePublicDirectoriesExist). */
function emptyRoot(handle) {
    const root = getUserDirectories(handle).root;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    return root;
}

function spySeed(impl = async () => {}) {
    const calls = [];
    const seed = async (directories) => {
        calls.push(directories);
        return impl(directories);
    };
    return { seed, calls };
}

test('not logged in: no seeding, next() called', async () => {
    const { seed, calls } = spySeed();
    const middleware = createEnsureUserSettingsFile({ seed });
    assert.equal((await run(middleware, {})).nextCalls, 1);
    assert.equal((await run(middleware, { user: { profile: { handle: 'x' } } })).nextCalls, 1);
    assert.equal(calls.length, 0);
});

test('settings.json present: no seeding, next() called', async () => {
    const root = emptyRoot('present');
    fs.writeFileSync(path.join(root, 'settings.json'), '{}');
    const { seed, calls } = spySeed();
    const result = await run(createEnsureUserSettingsFile({ seed }), userReq('present'));
    assert.equal(result.nextCalls, 1);
    assert.deepEqual(result.nextArgs, []);
    assert.equal(calls.length, 0);
});

test('missing user root (account being deleted): not recreated', async () => {
    const handle = 'gone';
    fs.rmSync(getUserDirectories(handle).root, { recursive: true, force: true });
    const { seed, calls } = spySeed();
    assert.equal((await run(createEnsureUserSettingsFile({ seed }), userReq(handle))).nextCalls, 1);
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(getUserDirectories(handle).root), false);
});

test('settings.json missing: seeded once before next(), parallel requests share the restore', async (t) => {
    const handle = 'resetuser';
    const root = emptyRoot(handle);
    const warn = t.mock.method(console, 'warn', () => {});
    let order = [];
    const { seed, calls } = spySeed(async () => {
        await new Promise(resolve => setImmediate(resolve));
        fs.writeFileSync(path.join(root, 'settings.json'), '{}');
        order.push('seeded');
    });
    const middleware = createEnsureUserSettingsFile({ seed });
    const req = userReq(handle);
    const results = await Promise.all([
        middleware(req, {}, () => order.push('next')),
        middleware(req, {}, () => order.push('next')),
        middleware(req, {}, () => order.push('next')),
    ]);
    assert.equal(results.length, 3);
    assert.equal(calls.length, 1, 'seeded once');
    assert.equal(calls[0].root, root);
    assert.deepEqual(order, ['seeded', 'next', 'next', 'next']);
    assert.equal(warn.mock.calls.length, 1, 'logged once per occurrence');
    assert.match(String(warn.mock.calls[0].arguments[0]), /settings\.json of resetuser was missing/);

    // A later occurrence is handled (and logged) again
    fs.rmSync(path.join(root, 'settings.json'));
    order = [];
    await run(middleware, req);
    assert.equal(calls.length, 2);
    assert.equal(warn.mock.calls.length, 2);
});

test('seeding errors never throw: next() is still called', async (t) => {
    emptyRoot('broken');
    const error = t.mock.method(console, 'error', () => {});
    const { seed } = spySeed(async () => { throw new Error('EIO'); });
    const result = await run(createEnsureUserSettingsFile({ seed }), userReq('broken'));
    assert.equal(result.nextCalls, 1);
    assert.deepEqual(result.nextArgs, [], 'no error passed on to Express');
    assert.ok(error.mock.calls.length >= 1);

    // Seed that "succeeds" without creating the file: logged as an error, request continues
    const noop = createEnsureUserSettingsFile({ seed: async () => {} });
    assert.equal((await run(noop, userReq('broken'))).nextCalls, 1);
    assert.ok(error.mock.calls.some(c => /could not be restored/.test(String(c.arguments[0]))));

    // Unexpected request shapes do not throw either
    const weird = { user: { directories: { root: 42 } } };
    assert.equal((await run(createEnsureUserSettingsFile({ seed: async () => {} }), weird)).nextCalls, 1);
});

test('official seeding with skipContentCheck: true -> reset leaves no settings.json, the safeguard restores it', async (t) => {
    t.mock.method(console, 'info', () => {});
    t.mock.method(console, 'log', () => {});
    const warn = t.mock.method(console, 'warn', () => {});
    const handle = 'official';
    const directories = getUserDirectories(handle);
    const settingsPath = path.join(directories.root, 'settings.json');

    // What POST /api/users/reset-step2 does: remove the root, recreate dirs, unforced content check
    emptyRoot(handle);
    await checkForNewContent([directories]);
    assert.equal(fs.existsSync(settingsPath), false, 'official reset path leaves the user without settings.json');

    const result = await run(ensureUserSettingsFile, userReq(handle));
    assert.equal(result.nextCalls, 1);
    assert.equal(fs.existsSync(settingsPath), true, 'settings.json restored');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    assert.ok(warn.mock.calls.some(c => /restored the default settings/.test(String(c.arguments[0]))));
    // Not the whole default set (~190 files, copied synchronously inside the request)
    const files = fs.readdirSync(directories.root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort();
    assert.deepEqual(files, ['settings.json', 'user-default.png']);
});

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
