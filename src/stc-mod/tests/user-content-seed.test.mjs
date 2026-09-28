/**
 * STC-MOD - default content of new / reset accounts (`newUserContent`) and the settings.json restore
 * used by the safeguard. Temp data root + official content seeding, no server, no network.
 * Run: node src/stc-mod/tests/user-content-seed.test.mjs
 */
/* global globalThis */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The official modules read config.yaml at import time: point them at a temp config first.
// STC-MOD reads <cwd>/config.yaml, so run from the temp dir as well.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-content-seed-'));
const configPath = path.join(tmpDir, 'config.yaml');
fs.writeFileSync(configPath, 'skipContentCheck: true\n');
const dataRoot = path.join(tmpDir, 'data');
fs.mkdirSync(dataRoot);
globalThis.DATA_ROOT = dataRoot;
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { setConfigFilePath } = await import('../../util.js');
setConfigFilePath(configPath);
const { getUserDirectories } = await import('../../users.js');
const { checkForNewContent, CONTENT_TYPES } = await import('../../endpoints/content-manager.js');
const {
    CONTENT_LOG_FILE, NEW_USER_CONTENT, getNewUserContentMode, getUserContentItems, parseNewUserContentMode,
    restoreUserSettings, seedNewUserContent,
} = await import('../services/user-content-seed.js');

const PRESET_DIRS = ['OpenAI Settings', 'TextGen Settings', 'KoboldAI Settings', 'NovelAI Settings', 'instruct', 'context', 'sysprompt', 'reasoning'];

/** Files below a user root: total and per top-level entry. */
function scan(root) {
    const out = { files: [], byTop: {} };
    const walk = (dir, top) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            const t = top ?? e.name;
            if (e.isDirectory()) walk(p, t);
            else {
                out.files.push(path.relative(root, p));
                out.byTop[t] = (out.byTop[t] || 0) + 1;
            }
        }
    };
    walk(root, null);
    out.presets = PRESET_DIRS.reduce((n, d) => n + (out.byTop[d] || 0), 0);
    return out;
}

/** Empty user root, like the official reset leaves it (rm root, recreate). */
function emptyRoot(handle) {
    const directories = getUserDirectories(handle);
    fs.rmSync(directories.root, { recursive: true, force: true });
    fs.mkdirSync(directories.root, { recursive: true });
    return directories;
}

function readLog(directories) {
    return fs.readFileSync(path.join(directories.root, CONTENT_LOG_FILE), 'utf8').split('\n');
}

function quiet(t) {
    for (const method of ['info', 'log', 'warn']) t.mock.method(console, method, () => {});
}

test('newUserContent: only "minimal" (any case) selects minimal, everything else is the official full seed', () => {
    assert.equal(parseNewUserContentMode('minimal'), NEW_USER_CONTENT.MINIMAL);
    assert.equal(parseNewUserContentMode(' Minimal '), NEW_USER_CONTENT.MINIMAL);
    for (const value of [undefined, null, '', 'full', 'none', true, 0]) {
        assert.equal(parseNewUserContentMode(value), NEW_USER_CONTENT.FULL, String(value));
    }
    assert.equal(getNewUserContentMode(), NEW_USER_CONTENT.FULL, 'unset in config.yaml');
    fs.writeFileSync(configPath, 'skipContentCheck: true\nnewUserContent: minimal\n');
    assert.equal(getNewUserContentMode(), NEW_USER_CONTENT.MINIMAL, 'read live from config.yaml');
    fs.writeFileSync(configPath, 'skipContentCheck: true\n');
    assert.equal(getNewUserContentMode(), NEW_USER_CONTENT.FULL);
});

test('full: a new account gets the whole official default set (skipContentCheck does not change that)', async (t) => {
    quiet(t);
    const directories = emptyRoot('fulluser');
    await seedNewUserContent(directories, { mode: NEW_USER_CONTENT.FULL });
    const s = scan(directories.root);
    assert.ok(s.files.length >= 150, `${s.files.length} files`);
    assert.ok(s.byTop.backgrounds > 0 && s.byTop.characters > 0 && s.presets > 50, JSON.stringify(s.byTop));
    assert.ok(fs.existsSync(path.join(directories.root, 'settings.json')));
});

test('minimal: a new account gets settings.json + the default persona avatar, content.log lists every default item', async (t) => {
    quiet(t);
    const directories = emptyRoot('minimaluser');
    await seedNewUserContent(directories, { mode: NEW_USER_CONTENT.MINIMAL });
    const s = scan(directories.root);
    assert.deepEqual(s.files.sort(), [CONTENT_LOG_FILE, path.join('User Avatars', 'user-default.png'), 'settings.json'].sort());
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8')));
    const log = readLog(directories);
    const items = getUserContentItems(directories);
    assert.ok(items.length >= 150);
    for (const item of items) assert.ok(log.includes(item.filename), `${item.filename} not in content.log`);

    // Official "reset settings" (forced SETTINGS seed) and a startup content check copy nothing else
    fs.rmSync(path.join(directories.root, 'settings.json'));
    await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
    const after = scan(directories.root);
    assert.equal(after.files.length, 3, after.files.join(', '));
    assert.ok(fs.existsSync(path.join(directories.root, 'settings.json')), 'reset settings restored settings.json only');
});

test('minimal: an existing content.log is never replaced', async (t) => {
    quiet(t);
    const directories = emptyRoot('haslog');
    fs.writeFileSync(path.join(directories.root, CONTENT_LOG_FILE), 'settings.json');
    await seedNewUserContent(directories, { mode: NEW_USER_CONTENT.MINIMAL });
    assert.equal(readLog(directories)[0], 'settings.json');
    assert.ok(scan(directories.root).files.length >= 150, 'official seeding of the unlisted items (existing behavior)');
});

test('restore (full mode) after an official reset: only settings.json + default avatar, no content.log, nothing else', async (t) => {
    quiet(t);
    const directories = emptyRoot('resetfull');
    await checkForNewContent([directories]); // what reset-step2 does; returns early with skipContentCheck: true
    assert.equal(scan(directories.root).files.length, 0);
    await restoreUserSettings(directories, { mode: NEW_USER_CONTENT.FULL });
    const s = scan(directories.root);
    assert.deepEqual(s.files.sort(), [path.join('User Avatars', 'user-default.png'), 'settings.json'].sort());
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8')));
});

test('restore (minimal mode) after an official reset: seeded like a new minimal account', async (t) => {
    quiet(t);
    const directories = emptyRoot('resetminimal');
    await restoreUserSettings(directories, { mode: NEW_USER_CONTENT.MINIMAL });
    const s = scan(directories.root);
    assert.deepEqual(s.files.sort(), [CONTENT_LOG_FILE, path.join('User Avatars', 'user-default.png'), 'settings.json'].sort());
    assert.ok(readLog(directories).length >= 150);
});

test('restore with content.log present (settings.json deleted): only settings.json comes back', async (t) => {
    quiet(t);
    for (const mode of [NEW_USER_CONTENT.FULL, NEW_USER_CONTENT.MINIMAL]) {
        const directories = emptyRoot(`deleted-${mode}`);
        await seedNewUserContent(directories, { mode });
        const before = scan(directories.root).files.length;
        fs.rmSync(path.join(directories.root, 'settings.json'));
        await restoreUserSettings(directories, { mode });
        assert.equal(scan(directories.root).files.length, before, mode);
        assert.ok(fs.existsSync(path.join(directories.root, 'settings.json')), mode);
    }
});

test('restore never overwrites existing files', async (t) => {
    quiet(t);
    const directories = emptyRoot('keep');
    fs.writeFileSync(path.join(directories.root, 'settings.json'), '{"mine":true}');
    fs.mkdirSync(directories.avatars, { recursive: true });
    fs.writeFileSync(path.join(directories.avatars, 'user-default.png'), 'mine');
    await restoreUserSettings(directories, { mode: NEW_USER_CONTENT.FULL });
    assert.equal(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'), '{"mine":true}');
    assert.equal(fs.readFileSync(path.join(directories.avatars, 'user-default.png'), 'utf8'), 'mine');
});

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
