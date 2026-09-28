/**
 * SillyTavernchat Module - Default content for new and reset accounts
 *
 * The official user creation (`checkForNewContent([directories], [CONTENT_TYPES.SETTINGS])`, also
 * used by STC registration) copies every default content item that the user's `content.log` does
 * not list yet. For a new account that is the whole default set (~190 files / ~15 MiB: backgrounds,
 * the sample character with sprites, presets, themes, ...), whatever `skipContentCheck` says. On
 * object storage (JuiceFS on B2) this dominates registration time and counts against the quota.
 *
 * config.yaml `newUserContent` (read on every registration, no restart needed):
 * - `full` (default): official behavior.
 * - `minimal`: accounts registered through STC-MOD (local, OAuth, QRole) get only the default
 *   settings.json, the default persona avatar it references (user-default.png) and the operator's
 *   scaffold content (default/scaffold, empty by default). Every other default item is listed in
 *   content.log as already offered, so later forced SETTINGS seeds (official "reset settings", the
 *   settings.json safeguard) and startup content checks do not copy it afterwards. Users can still
 *   import presets, backgrounds and characters manually.
 *
 * restoreUserSettings() backs the settings.json safeguard and never copies the whole default set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_FILE } from '../../constants.js';
import { serverDirectory } from '../../server-directory.js';
import { setPermissionsSync } from '../../util.js';
import { checkForNewContent, getUserTargetByType, CONTENT_TYPES } from '../../endpoints/content-manager.js';
import { getStcConfig } from '../config.js';

/** Values of config.yaml `newUserContent`. */
export const NEW_USER_CONTENT = Object.freeze({ FULL: 'full', MINIMAL: 'minimal' });

/** Official per-user content log (see content-manager.js seedContentForUser). */
export const CONTENT_LOG_FILE = 'content.log';

/** Official content index locations (same as content-manager.js getContentIndex, scaffold first). */
const SCAFFOLD_DIRECTORY = path.join(serverDirectory, 'default/scaffold');
const CONTENT_DIRECTORY = path.join(serverDirectory, 'default/content');

/** Default items copied to `minimal` accounts and restored by the safeguard (besides scaffold content). */
const MINIMAL_TYPES = Object.freeze([CONTENT_TYPES.SETTINGS, CONTENT_TYPES.AVATAR]);

/**
 * @typedef {Object} DefaultContentItem
 * @property {string} filename File name from the index (may contain sub folders)
 * @property {string} type Content type (CONTENT_TYPES value)
 * @property {string} folder Source folder of the index
 * @property {boolean} scaffold Operator scaffold content (default/scaffold)
 */

/**
 * Normalize a config value to a NEW_USER_CONTENT mode (anything unknown = full).
 * @param {unknown} value
 * @returns {'full'|'minimal'}
 */
export function parseNewUserContentMode(value) {
    return String(value ?? '').trim().toLowerCase() === NEW_USER_CONTENT.MINIMAL ? NEW_USER_CONTENT.MINIMAL : NEW_USER_CONTENT.FULL;
}

/**
 * Current `newUserContent` mode from config.yaml.
 * @returns {'full'|'minimal'}
 */
export function getNewUserContentMode() {
    return parseNewUserContentMode(getStcConfig('newUserContent', NEW_USER_CONTENT.FULL));
}

/**
 * @param {string} folder
 * @returns {DefaultContentItem[]}
 */
function readContentIndex(folder) {
    const indexPath = path.join(folder, 'index.json');
    if (!fs.existsSync(indexPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
        .filter(item => item && typeof item.filename === 'string' && typeof item.type === 'string')
        .map(item => ({ filename: item.filename, type: item.type, folder, scaffold: folder === SCAFFOLD_DIRECTORY }));
}

/**
 * Default content items that are seeded into user roots, in the official order (scaffold first).
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {DefaultContentItem[]}
 */
export function getUserContentItems(directories) {
    return [...readContentIndex(SCAFFOLD_DIRECTORY), ...readContentIndex(CONTENT_DIRECTORY)]
        .filter(item => getUserTargetByType(item.type, directories));
}

/**
 * Whether a `minimal` account receives this item.
 * @param {DefaultContentItem} item
 * @returns {boolean}
 */
function isMinimalItem(item) {
    return item.scaffold || MINIMAL_TYPES.includes(item.type);
}

/**
 * Create content.log listing every default item except the minimal ones, so the official seeding
 * copies only the minimal items. Never touches an existing content.log.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {boolean} true when the log was created
 */
function writeMinimalContentLog(directories) {
    const offered = getUserContentItems(directories).filter(item => !isMinimalItem(item)).map(item => item.filename);
    fs.mkdirSync(directories.root, { recursive: true });
    try {
        fs.writeFileSync(path.join(directories.root, CONTENT_LOG_FILE), offered.join('\n'), { flag: 'wx' });
        return true;
    } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
}

/**
 * Seed the default content of a new account (STC registration: local, OAuth, QRole).
 * `full`: the official seeding. `minimal`: content.log first, then the same official seeding, which
 * then copies only settings.json, the default persona avatar and scaffold content (plus the global
 * content, like the official user creation). Never throws for content problems (official behavior).
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {object} [options]
 * @param {'full'|'minimal'} [options.mode] Defaults to config.yaml `newUserContent`
 * @returns {Promise<void>}
 */
export async function seedNewUserContent(directories, { mode = getNewUserContentMode() } = {}) {
    if (mode === NEW_USER_CONTENT.MINIMAL) {
        try {
            writeMinimalContentLog(directories);
        } catch (error) {
            console.error('[STC-MOD] Minimal content seed failed, copying the full default content instead:', error?.message || error);
        }
    }
    await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
}

/**
 * Copy the default items of the given types that are missing in the user root. Never overwrites
 * (a file created concurrently wins); files only.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {readonly string[]} types
 * @returns {string[]} Paths of the copied files
 */
function copyMissingDefaults(directories, types) {
    const copied = [];
    for (const item of getUserContentItems(directories)) {
        if (!types.includes(item.type)) continue;
        const source = path.join(item.folder, item.filename);
        const targetDir = getUserTargetByType(item.type, directories);
        const target = path.join(targetDir, path.basename(item.filename));
        if (fs.existsSync(target)) continue;
        try {
            if (!fs.statSync(source).isFile()) continue;
        } catch {
            continue; // Missing default file (the official seeding only warns as well)
        }
        fs.mkdirSync(targetDir, { recursive: true });
        try {
            fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        } catch (error) {
            if (error?.code === 'EEXIST') continue;
            throw error;
        }
        setPermissionsSync(target);
        copied.push(target);
    }
    return copied;
}

/**
 * Restore a missing settings.json (settings.json safeguard) without copying the whole default set:
 * - `minimal` mode and no content.log (official account reset): seeded like a new `minimal` account;
 * - otherwise: only the default settings.json and, when missing, the default persona avatar it
 *   references. content.log is not touched.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {object} [options]
 * @param {'full'|'minimal'} [options.mode] Defaults to config.yaml `newUserContent`
 * @returns {Promise<void>}
 */
export async function restoreUserSettings(directories, { mode = getNewUserContentMode() } = {}) {
    if (mode === NEW_USER_CONTENT.MINIMAL && !fs.existsSync(path.join(directories.root, CONTENT_LOG_FILE))) {
        await seedNewUserContent(directories, { mode });
        return;
    }
    copyMissingDefaults(directories, MINIMAL_TYPES);
    if (!fs.existsSync(path.join(directories.root, SETTINGS_FILE))) {
        throw new Error('no default settings.json found in the content index');
    }
}
