/**
 * SillyTavernchat Module - Default User Template Service
 * Manages default configuration templates that are applied to new users.
 *
 * `stc-mod/default-template/template-meta.json` marks that a template exists. It is read with error
 * classification (services/json-store.js): missing = no template; unparseable = no template (a copy
 * is kept as `.corrupt-<ts>`); any other error throws StoreUnavailableError (HTTP 503), so an
 * outage is never reported as "no template".
 */
import fs from 'node:fs';
import path from 'node:path';
import storage from 'node-persist';
import { SETTINGS_FILE, USER_DIRECTORY_TEMPLATE } from '../../constants.js';
import { toKey } from '../../users.js';
import { getStcDataDir, getDataRoot } from '../config.js';
import {
    StoreUnavailableError,
    assertDataRootAvailable,
    isPlainObject,
    readJsonFile,
    writeJsonFileAtomic,
} from './json-store.js';

const DEFAULT_USER_AVATAR = 'user-default.png';

const TEMPLATE_DIR = 'default-template';
const TEMPLATE_META_FILE = 'template-meta.json';

/**
 * Template directory path (not created).
 * @returns {string}
 */
function getTemplateDir() {
    return path.join(getStcDataDir(), TEMPLATE_DIR);
}

/**
 * Template directory, created when missing (before writing).
 * @returns {string}
 */
function ensureTemplateDir() {
    const dir = getTemplateDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
        throw new StoreUnavailableError(`template directory could not be created (${error?.code || error?.message})`, { cause: error });
    }
    return dir;
}

function getTemplateMetaPath() {
    return path.join(getTemplateDir(), TEMPLATE_META_FILE);
}

/**
 * @returns {object|null} Template metadata, null when there is no (usable) template
 * @throws {StoreUnavailableError}
 */
function loadTemplateMeta() {
    const result = readJsonFile(getTemplateMetaPath(), { validate: isPlainObject, backup: false, label: 'Default template' });
    if (result.status === 'ok' || result.status === 'recovered') return result.data;
    if (result.status === 'corrupt') {
        console.error('[STC-MOD] Default template metadata is unreadable; no template is applied until it is saved again');
    }
    return null;
}

/**
 * Entries of the template directory (template-meta.json excluded); [] when the directory is missing.
 * @param {string} templateDir
 * @param {boolean} [includeMeta]
 * @returns {string[]}
 */
function listTemplateEntries(templateDir, includeMeta = false) {
    try {
        return fs.readdirSync(templateDir).filter(f => includeMeta || f !== TEMPLATE_META_FILE);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            assertDataRootAvailable();
            return [];
        }
        throw new StoreUnavailableError(`template directory could not be read (${error?.code || error?.message})`, { cause: error });
    }
}

/**
 * Save a user's configuration as the default template
 * @param {string} sourceHandle The user handle to snapshot from
 * @param {Object} options Which items to include
 */
export function saveTemplate(sourceHandle, options = {}) {
    const {
        includeSettings = true,
        includeSecrets = false,
        includePresets = true,
        includeRegex = true,
        includeCharacters = false,
        includeWorlds = false,
        includeThemes = true,
    } = options;

    // A lost data root mount must not look like "source user not found" (or be written to)
    assertDataRootAvailable();
    const sourceDir = path.join(getDataRoot(), sourceHandle);
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Source user directory not found: ${sourceHandle}`);
    }

    const templateDir = ensureTemplateDir();

    // Clean existing template
    const oldFiles = listTemplateEntries(templateDir);
    for (const f of oldFiles) {
        const fp = path.join(templateDir, f);
        if (fs.statSync(fp).isDirectory()) {
            fs.rmSync(fp, { recursive: true, force: true });
        } else {
            fs.unlinkSync(fp);
        }
    }

    const copied = [];

    function copyFile(relPath) {
        const src = path.join(sourceDir, relPath);
        const dst = path.join(templateDir, relPath);
        if (fs.existsSync(src)) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
            copied.push(relPath);
        }
    }

    function copyDir(relPath) {
        const src = path.join(sourceDir, relPath);
        const dst = path.join(templateDir, relPath);
        if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
            fs.cpSync(src, dst, { recursive: true });
            copied.push(relPath + '/');
        }
    }

    if (includeSettings) copyFile('settings.json');
    if (includeSecrets) copyFile('secrets.json');
    if (includePresets) {
        copyDir('TextGen Settings');
        copyDir('OpenAI Settings');
        copyDir('NovelAI Settings');
        copyDir('KoboldAI Settings');
    }
    if (includeRegex) copyDir('regex');
    if (includeCharacters) copyDir('characters');
    if (includeWorlds) copyDir('worlds');
    if (includeThemes) copyDir('themes');

    const meta = {
        sourceHandle,
        createdAt: Date.now(),
        options,
        copiedItems: copied,
    };
    writeJsonFileAtomic(getTemplateMetaPath(), meta);

    console.log(`[STC-MOD] Default template saved from user: ${sourceHandle}`);
    return meta;
}

async function resolveDisplayName(targetHandle, displayName) {
    if (typeof displayName === 'string' && displayName.trim()) {
        return displayName.trim();
    }

    try {
        const user = await storage.getItem(toKey(targetHandle));
        if (user?.name?.trim()) {
            return user.name.trim();
        }
    } catch {
        // Fall back to handle below
    }

    return targetHandle || 'User';
}

function avatarFileExists(targetDir, avatarFile) {
    if (!avatarFile || typeof avatarFile !== 'string') {
        return false;
    }

    const avatarPath = path.join(targetDir, USER_DIRECTORY_TEMPLATE.avatars, avatarFile);
    return fs.existsSync(avatarPath);
}

/**
 * Restore new-user identity fields after template settings overwrite source user data.
 * @param {string} targetHandle
 * @param {string} targetDir
 * @param {string} displayName
 */
function patchUserIdentitySettings(targetHandle, targetDir, displayName) {
    const settingsPath = path.join(targetDir, SETTINGS_FILE);
    if (!fs.existsSync(settingsPath)) {
        return;
    }

    let settings;
    try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
        console.error(`[STC-MOD] Failed to parse settings for ${targetHandle}:`, e.message);
        return;
    }

    settings.username = displayName;

    if (!avatarFileExists(targetDir, settings.user_avatar)) {
        settings.user_avatar = DEFAULT_USER_AVATAR;
    }

    if (settings.power_user && typeof settings.power_user === 'object') {
        const powerUser = settings.power_user;

        if (powerUser.default_persona && !avatarFileExists(targetDir, powerUser.default_persona)) {
            powerUser.default_persona = settings.user_avatar;
        }

        if (!powerUser.personas || typeof powerUser.personas !== 'object') {
            powerUser.personas = {};
        }

        const personaIds = new Set([
            settings.user_avatar,
            powerUser.default_persona,
        ].filter(Boolean));

        for (const personaId of personaIds) {
            powerUser.personas[personaId] = displayName;
        }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
}

/**
 * Apply default template to a new user directory
 * @param {string} targetHandle
 * @param {{ displayName?: string }} [options]
 */
export async function applyTemplate(targetHandle, { displayName } = {}) {
    const meta = loadTemplateMeta();
    if (!meta) return false;

    const templateDir = getTemplateDir();
    const targetDir = path.join(getDataRoot(), targetHandle);

    if (!fs.existsSync(targetDir)) return false;

    const files = listTemplateEntries(templateDir);
    for (const f of files) {
        const src = path.join(templateDir, f);
        const dst = path.join(targetDir, f);
        try {
            if (fs.statSync(src).isDirectory()) {
                fs.cpSync(src, dst, { recursive: true });
            } else {
                fs.copyFileSync(src, dst);
            }
        } catch (e) {
            console.error(`[STC-MOD] Failed to apply template file ${f}:`, e.message);
        }
    }

    const resolvedDisplayName = await resolveDisplayName(targetHandle, displayName);
    patchUserIdentitySettings(targetHandle, targetDir, resolvedDisplayName);

    console.log(`[STC-MOD] Default template applied to user: ${targetHandle}`);
    return true;
}

/**
 * Get current template metadata.
 * @returns {object|null} null when there is no template
 * @throws {StoreUnavailableError} The template store cannot be read
 */
export function getTemplateMeta() {
    return loadTemplateMeta();
}

/**
 * Delete current template
 * @throws {StoreUnavailableError}
 */
export function deleteTemplate() {
    const templateDir = getTemplateDir();
    const files = listTemplateEntries(templateDir, true);
    for (const f of files) {
        const fp = path.join(templateDir, f);
        if (fs.statSync(fp).isDirectory()) {
            fs.rmSync(fp, { recursive: true, force: true });
        } else {
            fs.unlinkSync(fp);
        }
    }
    return true;
}
