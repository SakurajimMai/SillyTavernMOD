/**
 * SillyTavernchat Module - settings.json safeguard
 *
 * With `skipContentCheck: true` in config.yaml, the official account reset
 * (POST /api/users/reset-step2) deletes the user root and re-seeds it with
 * `checkForNewContent([directories])` WITHOUT forcing the SETTINGS category, which returns early
 * when the content check is skipped. The user is left without settings.json and the official
 * POST /api/settings/get answers 500, so the UI cannot load. (The STC admin "reset user" also
 * deletes settings.json.)
 *
 * This middleware runs right before the official /api/settings/get handler: when the logged-in
 * user's root exists but settings.json is missing, it restores the default settings.json (see
 * user-content-seed.js restoreUserSettings: never the whole ~15 MiB default set, which would be
 * copied synchronously inside the request), then lets the official handler continue. It never
 * throws and has no effect when the file exists or when no user is logged in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_FILE } from '../../constants.js';
import { restoreUserSettings } from './user-content-seed.js';

/**
 * Create the safeguard middleware (the seed function is injectable for tests).
 * @param {object} [options]
 * @param {(directories: import('../../users.js').UserDirectoryList) => Promise<void>} [options.seed]
 * @returns {import('express').RequestHandler}
 */
export function createEnsureUserSettingsFile({ seed = restoreUserSettings } = {}) {
    /** Restorations in progress by user root, so parallel requests (several tabs) seed once. */
    const inFlight = new Map();

    /**
     * @param {import('../../users.js').UserDirectoryList} directories
     * @param {string} handle For logging only
     * @returns {Promise<void>}
     */
    function restore(directories, handle) {
        const root = directories.root;
        const running = inFlight.get(root);
        if (running) return running;
        const settingsPath = path.join(root, SETTINGS_FILE);
        const task = (async () => {
            try {
                await seed(directories);
                if (fs.existsSync(settingsPath)) {
                    console.warn(`[STC-MOD] settings.json of ${handle} was missing (e.g. account reset with skipContentCheck: true); restored the default settings.`);
                } else {
                    console.error(`[STC-MOD] settings.json of ${handle} is missing and could not be restored.`);
                }
            } catch (error) {
                console.error(`[STC-MOD] Failed to restore settings.json of ${handle}:`, error?.message || error);
            } finally {
                inFlight.delete(root);
            }
        })();
        inFlight.set(root, task);
        return task;
    }

    return async function ensureUserSettingsFile(req, res, next) {
        try {
            const directories = req.user?.directories;
            const root = directories?.root;
            // The official reset recreates the (empty) user root; a missing root means the
            // account is being deleted, which must not be undone here.
            if (root && !fs.existsSync(path.join(root, SETTINGS_FILE)) && fs.existsSync(root)) {
                await restore(directories, req.user?.profile?.handle ?? path.basename(root));
            }
        } catch (error) {
            console.error('[STC-MOD] settings.json safeguard error:', error?.message || error);
        }
        return next();
    };
}

/**
 * Middleware for POST /api/settings/get (see module comment).
 * @type {import('express').RequestHandler}
 */
export const ensureUserSettingsFile = createEnsureUserSettingsFile();
