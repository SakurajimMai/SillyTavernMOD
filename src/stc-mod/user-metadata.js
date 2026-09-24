/**
 * SillyTavernchat Module - Extended User Metadata
 * Maintains a separate data store for user extension fields (OAuth, email, storage, expiration).
 * Does NOT modify the official users.js user model.
 *
 * Persistence design:
 * - A single in-memory cache (`metadataCache`) is the source of truth at runtime.
 * - Writes are coalesced and flushed asynchronously to avoid rewriting the whole
 *   JSON file on every high-frequency update (e.g. heartbeats).
 * - Disk writes are atomic (write to a temp file, then rename) so a crash or a
 *   concurrent write can never leave a half-written / corrupted metadata file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getStcDataDir } from './config.js';

const METADATA_FILE = 'user-metadata.json';

// How long to wait before flushing coalesced writes to disk (ms).
const FLUSH_DEBOUNCE_MS = 5000;

/** @type {Object<string, UserExtendedData>|null} */
let metadataCache = null;
/** @type {NodeJS.Timeout|null} */
let flushTimer = null;
/** Whether the cache has unsaved changes. */
let dirty = false;

function getMetadataPath() {
    return path.join(getStcDataDir(), METADATA_FILE);
}

function loadMetadata() {
    if (metadataCache) return metadataCache;
    const filePath = getMetadataPath();
    if (!fs.existsSync(filePath)) {
        metadataCache = {};
        return metadataCache;
    }
    try {
        metadataCache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error('[STC-MOD] Failed to read user metadata:', e.message);
        // Try to recover from the last good backup rather than silently dropping all data.
        try {
            const backup = filePath + '.bak';
            if (fs.existsSync(backup)) {
                metadataCache = JSON.parse(fs.readFileSync(backup, 'utf8'));
                console.warn('[STC-MOD] Recovered user metadata from backup.');
                migrateLastActiveAt();
                return metadataCache;
            }
        } catch { /* fall through */ }
        metadataCache = {};
    }
    migrateLastActiveAt();
    return metadataCache;
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
    if (migrated > 0) {
        metadataCache._migrated_lastActiveAt = Date.now();
        dirty = true;
        // Flush immediately so the migration is durable
        flushSync();
        console.log(`[STC-MOD] Migration: backfilled lastActiveAt for ${migrated} users.`);
    } else {
        // Mark as done even if nothing to migrate
        metadataCache._migrated_lastActiveAt = Date.now();
        dirty = true;
        flushSync();
    }
}


/**
 * Atomically persist the current cache to disk.
 * Writes to a temp file and renames over the target so readers never observe a
 * partially written file. Keeps a single `.bak` copy of the previous good file.
 */
function flushSync() {
    if (!metadataCache || !dirty) return;
    const filePath = getMetadataPath();
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
        const data = JSON.stringify(metadataCache, null, 2);
        fs.writeFileSync(tmpPath, data, 'utf8');
        // Preserve the previous file as a backup before replacing it.
        if (fs.existsSync(filePath)) {
            try { fs.copyFileSync(filePath, filePath + '.bak'); } catch { /* best-effort */ }
        }
        fs.renameSync(tmpPath, filePath);
        dirty = false;
    } catch (e) {
        console.error('[STC-MOD] Failed to save user metadata:', e.message);
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
}

/**
 * Mark the cache dirty and schedule a debounced flush.
 * @param {boolean} [immediate] When true, flush synchronously right away.
 */
function scheduleFlush(immediate = false) {
    dirty = true;
    if (immediate) {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        flushSync();
        return;
    }
    // Always ensure a timer is scheduled when dirty=true. If a timer already
    // exists, don't replace it (let it run), but if no timer is running, start one.
    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushSync();
        }, FLUSH_DEBOUNCE_MS);
        flushTimer.unref?.();
    }
}

// Ensure pending changes are persisted on shutdown.
let exitHooked = false;
function ensureExitHook() {
    if (exitHooked) return;
    exitHooked = true;
    const onExit = () => flushSync();
    process.once('exit', onExit);
    process.once('SIGINT', () => { flushSync(); process.exit(0); });
    process.once('SIGTERM', () => { flushSync(); process.exit(0); });
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
 * @property {number} [lastActiveAt] - Last activity timestamp (set on login and heartbeat)
 * @property {string} [inviteCodeUsed] - Invite code used for registration
 * @property {boolean} [hasPassword] - Whether user has set a password (for OAuth users)
 * @property {boolean} [passwordAutoGenerated] - Stored password is a random one generated by STC-MOD (unknown to the user)
 * @property {number} [passwordSetAt] - Timestamp when password was set/updated
 * @property {string} [registrationMethod] - Registration method: 'local' | 'github' | 'discord' | 'linuxdo' | 'qrole'
 * @property {string|null} [qroleTier] - Last seen QRole membership tier (lowercase), e.g. 'vip' / 'svip'
 * @property {number|null} [qroleMembershipExpiresAt] - Last seen QRole membership expiry (ms), null = no expiry reported
 * @property {number} [qroleCheckedAt] - Timestamp of the last QRole membership check (on login)
 */

/**
 * Get extended data for a user
 * @param {string} handle User handle
 * @returns {UserExtendedData|null}
 */
export function getUserMeta(handle) {
    const meta = loadMetadata();
    if (!meta) return null;
    return meta[handle] || null;
}

/**
 * Set extended data for a user (merge with existing).
 * @param {string} handle User handle
 * @param {Partial<UserExtendedData>} data Data to merge
 * @param {object} [opts]
 * @param {boolean} [opts.immediate] Flush to disk synchronously instead of debounced.
 */
export function setUserMeta(handle, data, opts = {}) {
    const meta = loadMetadata();
    if (!meta) return; // Defensive: should never happen
    if (!meta[handle]) {
        meta[handle] = {};
    }
    Object.assign(meta[handle], data);
    scheduleFlush(opts.immediate === true);
}

/**
 * Delete extended data for a user
 * @param {string} handle
 */
export function deleteUserMeta(handle) {
    const meta = loadMetadata();
    if (!meta) return; // Defensive: should never happen
    delete meta[handle];
    scheduleFlush(true);
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
 * Find user handle by OAuth provider and user ID
 * @param {string} provider
 * @param {string} oauthUserId
 * @returns {string|null} handle or null
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
 * Updates only lastActiveAt and uses the debounced flush, so frequent pings do
 * not hammer the disk.
 * @param {string} handle
 */
export function recordActivity(handle) {
    const now = Date.now();
    // Use setUserMeta for all updates to ensure consistency.
    // The internal scheduleFlush(false) will automatically coalesce writes
    // within the debounce window, so high-frequency heartbeats are batched.
    setUserMeta(handle, { lastActiveAt: now });
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
 * Force an immediate synchronous flush of pending changes (for tests/admin ops).
 */
export function flushMetadata() {
    flushSync();
}

/**
 * Invalidate the in-memory cache (for testing or force-reload).
 * Flushes pending changes first so nothing is lost.
 */
export function invalidateCache() {
    flushSync();
    metadataCache = null;
}
