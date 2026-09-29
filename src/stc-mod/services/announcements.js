/**
 * SillyTavernchat Module - Announcement stores
 * `stc-mod/announcements/announcements.json` (main, for logged-in users) and
 * `stc-mod/announcements/login_announcements.json` (login page), both JSON arrays.
 * Shared by the admin routes and the public login-page route. Storage errors are never read as
 * "no announcements": StoreUnavailableError (HTTP 503), see services/json-store.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getStcDataDir } from '../config.js';
import { StoreUnavailableError, createJsonStore } from './json-store.js';

const ANNOUNCEMENTS_DIR = 'announcements';
const FILES = Object.freeze({
    main: 'announcements.json',
    login: 'login_announcements.json',
});

/**
 * Announcement directory path (not created).
 * @returns {string}
 */
function getAnnouncementsDir() {
    return path.join(getStcDataDir(), ANNOUNCEMENTS_DIR);
}

/**
 * Create the announcement directory before a write.
 */
function ensureAnnouncementsDir() {
    const dir = getAnnouncementsDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
        throw new StoreUnavailableError(`announcement directory could not be created (${error?.code || error?.message})`, { cause: error });
    }
}

/**
 * @param {'main'|'login'} type
 */
function createStore(type) {
    const store = createJsonStore({
        label: type === 'login' ? 'Login announcements' : 'Announcements',
        file: () => path.join(getAnnouncementsDir(), FILES[type]),
        validate: Array.isArray,
        empty: () => [],
    });
    return {
        ...store,
        update(mutator) {
            ensureAnnouncementsDir();
            return store.update(mutator);
        },
    };
}

const stores = {
    main: createStore('main'),
    login: createStore('login'),
};

/**
 * Normalize the `type` query parameter: 'login' or 'main' (anything else).
 * @param {*} type
 * @returns {'main'|'login'}
 */
export function normalizeAnnouncementType(type) {
    return String(type ?? 'main') === 'login' ? 'login' : 'main';
}

/**
 * Store of one announcement list.
 * @param {*} type 'login' or 'main'
 */
export function getAnnouncementStore(type) {
    return stores[normalizeAnnouncementType(type)];
}

/**
 * All announcements of a list.
 * @param {*} type 'login' or 'main'
 * @returns {object[]}
 * @throws {StoreUnavailableError}
 */
export function loadAnnouncements(type) {
    return getAnnouncementStore(type).read();
}
