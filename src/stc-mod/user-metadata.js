/**
 * SillyTavernchat Module - Extended User Metadata
 * Maintains a separate data store for user extension fields (OAuth, email, storage, expiration).
 * Does NOT modify the official users.js user model.
 *
 * Persistence design:
 * - A single in-memory cache (`metadataCache`) is the source of truth at runtime once it was loaded
 *   successfully; readers see every update immediately, disk writes happen later.
 * - Loading classifies read errors (services/json-store.js): a missing file starts an empty store
 *   (unless `user-metadata.json.bak` is valid: then the backup is used and the file recreated);
 *   an unparseable file is recovered from `user-metadata.json.bak`, or (no usable `.bak`) kept as
 *   `<name>.corrupt-<timestamp>` while the store starts empty. Any other error (EIO, ENOTCONN,
 *   EACCES, a lost data root mount, ...) is StoreUnavailableError: NO empty cache is created, every
 *   access throws (HTTP 503) and the load is retried on a later access (at most once per
 *   LOAD_RETRY_MS). Nothing is ever written before a successful load.
 * - Writes are coalesced (services/flush-scheduler.js) because the whole JSON file is rewritten on
 *   every flush and the data root may be remote object storage (JuiceFS on B2: each rewrite uploads
 *   new chunks and keeps the replaced version in the trash):
 *   - activity-only changes (`lastActiveAt` from heartbeats) are flushed at most once per
 *     ACTIVITY_FLUSH_MS (60 s);
 *   - real changes are flushed within FLUSH_DEBOUNCE_MS (5 s), also when activity was already
 *     pending (the earlier deadline wins);
 *   - `immediate: true`, flushMetadata() and the exit/SIGINT/SIGTERM hooks flush everything now.
 *   A failed flush keeps the changes pending and is retried.
 * - Disk writes are atomic (write to a temp file, then rename) so a crash or a
 *   concurrent write can never leave a half-written / corrupted metadata file.
 * - When the store was loaded as missing, the first write only creates the file: if a
 *   user-metadata.json appeared meanwhile (e.g. the mount came back), it is merged into the cache
 *   instead of being overwritten.
 * - `user-metadata.json.bak` is refreshed (copy of the current file) only by flushes that contain a
 *   real change, so it holds the last state before the most recent real change; its
 *   `lastActiveAt` values may be older. It is never refreshed from a main file known to be unreadable.
 */
import path from 'node:path';
import { getStcDataDir } from './config.js';
import { createFlushScheduler } from './services/flush-scheduler.js';
import {
    StoreConflictError,
    StoreUnavailableError,
    isPlainObject,
    isStoreUnavailableError,
    readJsonFile,
    writeJsonFileAtomic,
} from './services/json-store.js';

const METADATA_FILE = 'user-metadata.json';

/** How long to wait before flushing coalesced real changes to disk (ms). */
export const FLUSH_DEBOUNCE_MS = 5000;
/** Activity-only changes (lastActiveAt) are written at most this often (ms). */
export const ACTIVITY_FLUSH_MS = 60_000;
/** After a failed load (store unavailable), the next load attempt happens at most this often (ms). */
export const LOAD_RETRY_MS = 5000;
/** Fields whose updates alone are activity-only changes (see setUserMeta). */
const ACTIVITY_ONLY_KEYS = new Set(['lastActiveAt']);

/** @type {Object<string, UserExtendedData>|null} */
let metadataCache = null;
/**
 * Last failed load: every access rethrows it until the next attempt is due.
 * @type {{error: StoreUnavailableError, at: number}|null}
 */
let loadFailure = null;
/**
 * The store was loaded as missing: the first write must not replace a file that appeared meanwhile.
 */
let expectMissingFile = false;

function getMetadataPath() {
    return path.join(getStcDataDir(), METADATA_FILE);
}

/**
 * Load the metadata file into the cache (or rethrow the last failure while a retry is not due).
 * @returns {Object<string, UserExtendedData>}
 * @throws {StoreUnavailableError}
 */
function loadMetadata() {
    if (metadataCache) return metadataCache;
    const now = Date.now();
    if (loadFailure && now >= loadFailure.at && now - loadFailure.at < LOAD_RETRY_MS) {
        throw loadFailure.error;
    }

    let result;
    try {
        result = readJsonFile(getMetadataPath(), { validate: isPlainObject, backup: true, label: 'User metadata' });
    } catch (error) {
        const failure = isStoreUnavailableError(error)
            ? /** @type {StoreUnavailableError} */ (error)
            : new StoreUnavailableError(`user metadata could not be loaded (${error?.message || error})`, { cause: error });
        console.error(`[STC-MOD] User metadata unavailable (${failure.detail}); requests that need it answer 503, next attempt in ${LOAD_RETRY_MS / 1000} s. Nothing is written until it was read.`);
        loadFailure = { error: failure, at: now };
        throw failure;
    }

    if (loadFailure) console.log('[STC-MOD] User metadata is readable again.');
    loadFailure = null;
    // Also when the data comes from `.bak` because the main file is missing
    expectMissingFile = result.status === 'missing' || result.mainMissing === true;
    if (result.status === 'ok' || result.status === 'recovered') {
        metadataCache = result.data;
    } else {
        if (result.status === 'corrupt') {
            console.error('[STC-MOD] User metadata could not be read and has no usable backup: starting with an empty store (the unreadable file was kept).');
        }
        metadataCache = {};
    }
    migrateLastActiveAt();
    return metadataCache;
}

/**
 * Load the metadata now (no-op when already loaded).
 * Call before irreversible steps that need the metadata later (e.g. creating an account), so that
 * an unavailable store stops them before anything was changed.
 * @throws {StoreUnavailableError}
 */
export function ensureUserMetadataLoaded() {
    loadMetadata();
}

/**
 * Load state for diagnostics / tests.
 * @returns {{loaded: boolean, error: string|null, failedAt: number|null}}
 */
export function getMetadataLoadState() {
    return {
        loaded: metadataCache !== null,
        error: loadFailure ? loadFailure.error.detail : null,
        failedAt: loadFailure ? loadFailure.at : null,
    };
}

/**
 * One-time migration: backfill `lastActiveAt` for users who have
 * `lastLoginAt` or `createdAt` but no `lastActiveAt`.
 * This covers all users created before the heartbeat feature was added.
 * Uses a sentinel key to ensure it only runs once.
 */
function migrateLastActiveAt() {
    if (!metadataCache || metadataCache._migrated_lastActiveAt) return;
    let migrated = 0;
    for (const [handle, data] of Object.entries(metadataCache)) {
        if (handle.startsWith('_')) continue; // skip sentinel keys
        if (!data || typeof data !== 'object') continue;
        if (!data.lastActiveAt && (data.lastLoginAt || data.createdAt)) {
            data.lastActiveAt = data.lastLoginAt || data.createdAt;
            migrated++;
        }
    }
    // Mark as done even if nothing was migrated; flush immediately so the migration is durable
    metadataCache._migrated_lastActiveAt = Date.now();
    flushScheduler.markReal();
    flushScheduler.flushNow();
    if (migrated > 0) {
        console.log(`[STC-MOD] Migration: backfilled lastActiveAt for ${migrated} users.`);
    }
}

/**
 * The store was loaded as missing but a metadata file appeared before the first write: merge that
 * file into the cache (entries and fields only on disk are added, the in-memory changes win)
 * instead of overwriting it, then write the result.
 * @param {string} filePath
 * @param {boolean} refreshBackup
 * @returns {boolean}
 */
function mergeAppearedFile(filePath, refreshBackup) {
    console.error('[STC-MOD] user-metadata.json appeared after the store was started empty; merging it instead of overwriting it.');
    const result = readJsonFile(filePath, { validate: isPlainObject, backup: true, label: 'User metadata' });
    if (result.status === 'ok' || result.status === 'recovered') {
        for (const [key, value] of Object.entries(result.data)) {
            const current = metadataCache[key];
            if (!Object.hasOwn(metadataCache, key)) {
                metadataCache[key] = value;
            } else if (isPlainObject(current) && isPlainObject(value)) {
                for (const [field, fieldValue] of Object.entries(value)) {
                    if (!Object.hasOwn(current, field)) current[field] = fieldValue;
                }
            }
        }
    }
    expectMissingFile = result.status === 'missing' || result.mainMissing === true;
    writeJsonFileAtomic(filePath, metadataCache, { backup: refreshBackup, expectMissing: expectMissingFile });
    expectMissingFile = false;
    return true;
}

/**
 * Atomically persist the current cache to disk.
 * Writes to a temp file and renames over the target so readers never observe a
 * partially written file. Called by the flush scheduler only.
 * @param {boolean} refreshBackup Copy the current file to `.bak` first (flushes with a real change)
 * @returns {boolean} false when the write failed (the scheduler keeps the changes pending)
 */
function writeMetadataFile(refreshBackup) {
    // Never write anything that was not loaded successfully first
    if (!metadataCache) return true;
    let filePath = '';
    try {
        filePath = getMetadataPath();
        writeJsonFileAtomic(filePath, metadataCache, { backup: refreshBackup, expectMissing: expectMissingFile });
        expectMissingFile = false;
        return true;
    } catch (writeError) {
        let error = writeError;
        try {
            if (error instanceof StoreConflictError) return mergeAppearedFile(filePath, refreshBackup);
        } catch (mergeError) {
            error = mergeError;
        }
        console.error('[STC-MOD] Failed to save user metadata:', error?.detail || error?.message);
        return false;
    }
}

const flushScheduler = createFlushScheduler({
    flush: ({ real }) => writeMetadataFile(real),
    realDelayMs: FLUSH_DEBOUNCE_MS,
    activityDelayMs: ACTIVITY_FLUSH_MS,
    onError: (e) => console.error('[STC-MOD] Failed to save user metadata:', /** @type {Error} */ (e)?.message),
});

/**
 * Record a change and schedule the matching flush.
 * @param {boolean} activityOnly Only activity fields (lastActiveAt) changed
 * @param {boolean} immediate Flush synchronously right away
 * @returns {boolean} false when the immediate flush failed (the change stays pending and is retried)
 */
function scheduleFlush(activityOnly, immediate) {
    if (activityOnly) {
        flushScheduler.markActivity();
    } else {
        flushScheduler.markReal();
    }
    return immediate ? flushScheduler.flushNow() : true;
}

/** Flush everything pending (activity included); used by the shutdown hooks. */
function stcFlushUserMetadataOnExit() {
    flushScheduler.flushNow();
}

/**
 * Signal handling: flush, then exit only when nobody else handles the signal. The official graceful
 * shutdown (server-main.js `exitProcess`: stats, plugins, disk cache) registers its SIGINT/SIGTERM
 * listeners after this module is loaded and ends with process.exit(), which runs the 'exit' hook
 * (flushes again if anything changed meanwhile). Before those listeners exist (early startup, tests)
 * a registered listener would otherwise disable Node's default exit on the signal.
 * @param {NodeJS.Signals} signal
 */
function flushOnSignal(signal) {
    stcFlushUserMetadataOnExit();
    // `once` listeners are removed before they run: anything left is another handler
    if (process.listenerCount(signal) === 0) process.exit(0);
}

// Ensure pending changes are persisted on shutdown.
let exitHooked = false;
function ensureExitHook() {
    if (exitHooked) return;
    exitHooked = true;
    process.once('exit', stcFlushUserMetadataOnExit);
    process.once('SIGINT', function stcFlushUserMetadataOnSigint() { flushOnSignal('SIGINT'); });
    process.once('SIGTERM', function stcFlushUserMetadataOnSigterm() { flushOnSignal('SIGTERM'); });
}
ensureExitHook();

/**
 * @typedef {Object} UserExtendedData
 * @property {string} [email] - User email
 * @property {string} [oauthProvider] - OAuth provider name (github/discord/linuxdo/qrole)
 * @property {string} [oauthUserId] - OAuth user ID from provider
 * @property {string} [avatar] - Avatar URL or base64
 * @property {number} [storageLimitMiB] - Storage limit in MiB
 * @property {string} [storageLastCheckInDate] - Last check-in date (YYYY-MM-DD)
 * @property {number} [expiresAt] - Account expiration timestamp (ms), 0 = permanent
 * @property {number} [createdAt] - Registration timestamp
 * @property {number} [lastLoginAt] - Last login timestamp (set only on actual login)
 * @property {number} [lastActiveAt] - Last activity timestamp (set on login and heartbeat; heartbeat-only updates are written at most every 60 s)
 * @property {string} [inviteCodeUsed] - Invite code used for registration
 * @property {boolean} [hasPassword] - Whether user has set a password (for OAuth users)
 * @property {boolean} [passwordAutoGenerated] - Stored password is a random one generated by STC-MOD (unknown to the user)
 * @property {number} [passwordSetAt] - Timestamp when password was set/updated
 * @property {string} [registrationMethod] - Registration method: 'local' | 'github' | 'discord' | 'linuxdo' | 'qrole'
 * @property {string|null} [qroleTier] - Last seen QRole membership tier (lowercase), e.g. 'vip' / 'svip'
 * @property {number|null} [qroleMembershipExpiresAt] - Last seen QRole membership expiry (ms), null = no expiry reported
 * @property {number} [qroleCheckedAt] - Timestamp of the last QRole membership check (login or background re-verification)
 * @property {string|null} [qroleTierName] - Last seen QRole membership tier display name (membership_tier_name)
 * @property {number|null} [qroleDeniedAt] - Most recent denied QRole login (a background check that finds no valid membership only sets it when missing); null while the last check found a valid membership
 * @property {'refresh'} [qroleVerifiedVia] - How the last background re-verification was done
 * @property {string} [qroleRefreshToken] - QRole refresh token, AES-256-GCM encrypted with the local key file (NEVER returned by any API)
 * @property {number} [qroleRefreshTokenExpiresAt] - When the stored QRole refresh token expires (ms)
 */

/** Metadata keys that must never leave the server (see sanitizeMeta). */
export const SECRET_META_KEYS = Object.freeze(['qroleRefreshToken']);

/**
 * Copy of a metadata entry without secret fields, for every API that returns metadata.
 * @param {UserExtendedData|null|undefined} meta
 * @returns {UserExtendedData|null|undefined} Shallow copy without secrets (input returned as-is when not an object)
 */
export function sanitizeMeta(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const copy = { ...meta };
    for (const key of SECRET_META_KEYS) delete copy[key];
    return copy;
}

/**
 * Get extended data for a user.
 * Every accessor below throws StoreUnavailableError while the metadata could not be loaded.
 * @param {string} handle User handle
 * @returns {UserExtendedData|null}
 * @throws {StoreUnavailableError}
 */
export function getUserMeta(handle) {
    const meta = loadMetadata();
    if (!meta) return null;
    return meta[handle] || null;
}

/**
 * Whether a patch only touches activity fields (lastActiveAt): such updates are written at most
 * once per ACTIVITY_FLUSH_MS and never refresh the `.bak` copy.
 * @param {object} data Patch passed to setUserMeta
 * @returns {boolean}
 */
export function isActivityOnlyPatch(data) {
    if (!data || typeof data !== 'object') return false;
    const keys = Object.keys(data);
    return keys.length > 0 && keys.every(key => ACTIVITY_ONLY_KEYS.has(key));
}

/**
 * Set extended data for a user (merge with existing).
 * The change is visible to readers immediately. A patch that only sets `lastActiveAt` is an
 * activity-only change (flushed within ACTIVITY_FLUSH_MS); anything else is a real change
 * (flushed within FLUSH_DEBOUNCE_MS).
 * @param {string} handle User handle
 * @param {Partial<UserExtendedData>} data Data to merge
 * @param {object} [opts]
 * @param {boolean} [opts.immediate] Flush to disk synchronously instead of debounced.
 * @returns {boolean} false when an immediate flush failed: the change is in memory and stays pending
 *   (retried), but is not on disk yet
 */
export function setUserMeta(handle, data, opts = {}) {
    const meta = loadMetadata();
    if (!meta) return false; // Defensive: should never happen
    if (!meta[handle]) {
        meta[handle] = {};
    }
    Object.assign(meta[handle], data);
    return scheduleFlush(isActivityOnlyPatch(data), opts.immediate === true);
}

/**
 * Remove fields from a user's extended data. Does nothing (and creates no entry) for unknown handles.
 * @param {string} handle User handle
 * @param {readonly string[]} fields Keys to remove
 * @param {object} [opts]
 * @param {boolean} [opts.immediate] Flush to disk synchronously instead of debounced.
 * @returns {boolean} Whether anything was removed
 */
export function unsetUserMetaFields(handle, fields, opts = {}) {
    const meta = loadMetadata();
    const entry = meta?.[handle];
    if (!entry || typeof entry !== 'object') return false;
    let changed = false;
    for (const field of fields) {
        if (Object.hasOwn(entry, field)) {
            delete entry[field];
            changed = true;
        }
    }
    if (changed) scheduleFlush(false, opts.immediate === true);
    return changed;
}

/**
 * Delete extended data for a user
 * @param {string} handle
 */
export function deleteUserMeta(handle) {
    const meta = loadMetadata();
    if (!meta) return; // Defensive: should never happen
    delete meta[handle];
    scheduleFlush(false, true);
}

/**
 * Get all user metadata entries
 * @returns {Object<string, UserExtendedData>}
 */
export function getAllUserMeta() {
    const raw = loadMetadata() || {};
    const result = {};
    for (const [key, val] of Object.entries(raw)) {
        if (!key.startsWith('_')) result[key] = val;
    }
    return result;
}

/**
 * Check if a user account has expired
 * @param {string} handle
 * @returns {boolean}
 */
export function isUserExpired(handle) {
    const meta = getUserMeta(handle);
    if (!meta || !meta.expiresAt) return false;
    if (meta.expiresAt === 0) return false; // permanent
    return Date.now() > meta.expiresAt;
}

/**
 * Find user handle by OAuth provider and user ID.
 * Throws (never returns null) while the metadata is unavailable, so a login can never create a
 * second account for an identity that is already linked.
 * @param {string} provider
 * @param {string} oauthUserId
 * @returns {string|null} handle or null
 * @throws {StoreUnavailableError}
 */
export function findUserByOAuth(provider, oauthUserId) {
    const meta = loadMetadata();
    if (!meta) return null;
    for (const [handle, data] of Object.entries(meta)) {
        if (data.oauthProvider === provider && String(data.oauthUserId) === String(oauthUserId)) {
            return handle;
        }
    }
    return null;
}

/**
 * Find user handle by email
 * @param {string} email
 * @returns {string|null} handle or null
 */
export function findUserByEmail(email) {
    if (!email) return null;
    const meta = loadMetadata();
    if (!meta) return null;
    const lowerEmail = email.toLowerCase();
    for (const [handle, data] of Object.entries(meta)) {
        if (data.email && data.email.toLowerCase() === lowerEmail) {
            return handle;
        }
    }
    return null;
}

/**
 * Record an actual login event.
 * Updates both lastLoginAt (login-only) and lastActiveAt. Flushed immediately
 * because logins are infrequent and we want them durable.
 * @param {string} handle
 */
export function recordLogin(handle) {
    const now = Date.now();
    setUserMeta(handle, { lastLoginAt: now, lastActiveAt: now }, { immediate: true });
}

/**
 * Record a lightweight activity ping (e.g. heartbeat).
 * Updates only lastActiveAt: an activity-only change, written at most once per
 * ACTIVITY_FLUSH_MS (together with every other pending change) and without a `.bak` refresh,
 * so frequent pings from many open tabs do not rewrite the file every few seconds.
 * @param {string} handle
 */
export function recordActivity(handle) {
    setUserMeta(handle, { lastActiveAt: Date.now() });
}

/**
 * Resolve the best-known activity timestamp for a user, falling back across
 * lastActiveAt -> lastLoginAt -> createdAt. Central helper so every caller uses
 * the same definition of "activity" (no more divergent criteria).
 * @param {UserExtendedData|null|undefined} meta
 * @returns {number} timestamp in ms, or 0 if unknown
 */
export function resolveActivityTime(meta) {
    if (!meta) return 0;
    return meta.lastActiveAt || meta.lastLoginAt || meta.createdAt || 0;
}

/**
 * Compute aggregate user statistics for the admin dashboard.
 * Calculated server-side so the frontend does not have to iterate all metadata.
 * @param {object} [opts]
 * @param {number} [opts.activeWindowDays] Window (days) to count a user as active. Default 7.
 * @returns {{ total:number, active:number, inactive:number, expired:number, newToday:number, activeWindowDays:number }}
 */
export function getUserStats(opts = {}) {
    const activeWindowDays = opts.activeWindowDays ?? 7;
    const meta = loadMetadata();
    if (!meta) return { total: 0, active: 0, inactive: 0, expired: 0, newToday: 0, activeWindowDays };

    const now = Date.now();
    const activeThreshold = activeWindowDays * 24 * 60 * 60 * 1000;
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayMs = startOfToday.getTime();

    let total = 0, active = 0, expired = 0, newToday = 0;
    for (const [handle, data] of Object.entries(meta)) {
        if (handle.startsWith('_')) continue; // skip internal sentinel keys
        total++;
        const lastActive = resolveActivityTime(data);
        if (lastActive && now - lastActive <= activeThreshold) active++;
        if (isUserExpired(handle)) expired++;
        if (data.createdAt && data.createdAt >= startOfTodayMs) newToday++;
    }

    return {
        total,
        active,
        inactive: total - active,
        expired,
        newToday,
        activeWindowDays,
    };
}

/**
 * Extend user expiration by a duration in milliseconds.
 * Pass durationMs = 0 to set the account as permanent (expiresAt = 0).
 * @param {string} handle
 * @param {number} durationMs  0 means permanent
 */
export function extendExpiration(handle, durationMs) {
    if (durationMs === 0) {
        setUserMeta(handle, { expiresAt: 0 }, { immediate: true });
        return;
    }
    const meta = getUserMeta(handle);
    if (!meta) return; // User doesn't exist
    const now = Date.now();
    const currentExpiry = meta.expiresAt ?? now;
    const base = (currentExpiry !== 0 && currentExpiry > now) ? currentExpiry : now;
    setUserMeta(handle, { expiresAt: base + durationMs }, { immediate: true });
}

/**
 * Force an immediate synchronous flush of everything pending, activity included (for tests/admin ops).
 * @returns {boolean} false when the write failed (the changes stay pending and are retried)
 */
export function flushMetadata() {
    return flushScheduler.flushNow();
}

/**
 * Pending write state (for diagnostics and tests). `dueAt` is monotonic (performance.now() ms).
 * @returns {{pending: 'none'|'activity'|'real', dueAt: number|null}}
 */
export function getMetadataFlushState() {
    return flushScheduler.getState();
}

/**
 * Invalidate the in-memory cache (for testing or force-reload).
 * Flushes pending changes first; when that write fails the cache is kept (with the changes still
 * pending and a retry armed) so nothing is lost.
 * @returns {boolean} Whether the cache was dropped
 */
export function invalidateCache() {
    if (!flushScheduler.flushNow()) {
        console.error('[STC-MOD] User metadata cache kept: pending changes could not be written (retry scheduled).');
        return false;
    }
    metadataCache = null;
    loadFailure = null; // the next access loads again right away
    expectMissingFile = false;
    return true;
}
