/**
 * SillyTavernchat Module - QRole account management and optional automatic cleanup
 *
 * Lists the QRole-linked accounts with their membership state (active / expired / not_member) and,
 * when `oauth.qrole.expiredCleanup.enabled` is on (and the membership gate is on), deletes accounts
 * whose membership lapsed long enough ago: `cleanupAt` = the latest of the lapse date, the last
 * activity and the last login + `afterDays` days. Before deleting, an account with a usable refresh
 * token is re-verified with QRole (renewed accounts are kept; QRole being unreachable or rejecting
 * this site's client credentials postpones the deletion). Right before the deletion, under the
 * per-account deletion lock, the settings and the account are read again and the eligibility is
 * recomputed (renewed, re-linked or promoted accounts are kept; switching cleanup off stops the
 * run). At most 20 accounts are deleted per run; the job runs at most once per 24 h.
 * Run state lives in `stc-mod/qrole-cleanup-state.json`, deletions are logged to
 * `stc-mod/qrole-cleanup-log.json` (last 200 entries) under the STC data dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import storage from 'node-persist';
import { toKey } from '../../users.js';
import { getStcDataDir } from '../config.js';
import { getAllUserMeta } from '../user-metadata.js';
import { isMetaForRecord } from './account-security.js';
import { calculateUserStorageAsync } from './storage-quota.js';
import { deleteUserWithLock } from './user-deletion.js';
import { loadLiveQroleAccount, verifyQroleMembership } from './qrole-reverify.js';
import { isTokenKeyAvailable } from './qrole-token-crypto.js';
import {
    checkCleanupStillDue,
    computeCleanupAt,
    getCleanupEligibility,
    getQroleAccountState,
    getQroleConfig,
    hasStoredRefreshToken,
    isCleanupActive,
    isRefreshTokenFeatureOn,
    isTierAllowed,
    normalizeTier,
    resolveQroleLifecycleConfig,
    stateToReason,
    toTimestamp,
} from './qrole-lifecycle.js';

export const MAX_DELETIONS_PER_RUN = 20;
// Bound the run time when many candidates hold refresh tokens (each check may take up to 8 s)
const MAX_VERIFICATIONS_PER_RUN = 50;
// Stop re-verifying (and postpone those accounts) once QRole looks unreachable
const MAX_CONSECUTIVE_TRANSIENT = 3;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 5 * 60 * 1000;
const STORAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const STORAGE_CONCURRENCY = 4;
const RECORD_CONCURRENCY = 8;
const STATE_FILE = 'qrole-cleanup-state.json';
const LOG_FILE = 'qrole-cleanup-log.json';
const MAX_LOG_ENTRIES = 200;
const MAX_RESULT_DETAILS = 50;
const DEFAULT_USER_HANDLE = 'default-user';

/** @type {Map<string, {bytes: number|null, at: number}>} */
const storageCache = new Map();
/** @type {Promise<CleanupResult>|null} */
let runningCleanup = null;
/** @type {number|null} When the running cleanup started */
let runningSince = null;
// Fallback when the state file cannot be written, so the scheduler does not rerun every hour
let memoryLastRunAt = 0;
let schedulerStarted = false;

/**
 * @typedef {Object} QroleAccountEntry
 * @property {string} handle
 * @property {string} name
 * @property {boolean} enabled
 * @property {string|null} tier
 * @property {string|null} tierName
 * @property {boolean} tierAllowed
 * @property {'active'|'expired'|'not_member'} state
 * @property {number|null} expiresAt
 * @property {number|null} expiredSince
 * @property {number|null} checkedAt
 * @property {number|null} lastLoginAt
 * @property {number|null} lastActiveAt
 * @property {number|null} storageBytes
 * @property {boolean} hasRefreshToken
 * @property {number|null} refreshTokenExpiresAt
 * @property {number|null} cleanupAt
 */

/**
 * @typedef {Object} CleanupDeletion
 * @property {number} at
 * @property {string} handle
 * @property {'membership_expired'|'not_member'|null} reason
 * @property {number|null} expiresAt
 * @property {number|null} expiredSince
 * @property {number|null} storageBytes
 * @property {string|null} verify Re-verification result before the deletion (null = no token)
 * @property {string} trigger
 */

/**
 * @typedef {Object} CleanupResult
 * @property {'scheduler'|'manual'} trigger
 * @property {number} startedAt
 * @property {number|null} finishedAt
 * @property {number} afterDays
 * @property {number} candidates Accounts due for cleanup when the run started
 * @property {number} deletedCount
 * @property {number} skippedCount
 * @property {number} failedCount
 * @property {number} remaining Due accounts left for the next run (per-run limit)
 * @property {CleanupDeletion[]} deleted
 * @property {{handle: string, reason: string}[]} skipped
 * @property {{handle: string, error: string}[]} failed
 * @property {'disabled'} [stopped] Set when the run ended early because cleanup (or the membership
 *   gate) was switched off while it was running
 * @property {string} [error] Set when the run itself failed
 */

/**
 * Read a JSON file from the STC data dir.
 * @param {string} fileName
 * @param {*} fallback
 * @returns {*}
 */
function readDataFile(fileName, fallback) {
    try {
        return JSON.parse(fs.readFileSync(path.join(getStcDataDir(), fileName), 'utf8'));
    } catch {
        return fallback;
    }
}

/**
 * Atomically write a JSON file to the STC data dir (temp file + rename).
 * @param {string} fileName
 * @param {*} data
 * @returns {boolean}
 */
function writeDataFile(fileName, data) {
    const filePath = path.join(getStcDataDir(), fileName);
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (error) {
        console.error(`[STC-MOD] Failed to write ${fileName}:`, error?.message);
        try {
            fs.rmSync(tmpPath, { force: true });
        } catch {
            // Ignore cleanup errors
        }
        return false;
    }
}

/**
 * Last cleanup run.
 * @returns {{lastRunAt: number|null, lastResult: CleanupResult|null}}
 */
export function readCleanupState() {
    const state = readDataFile(STATE_FILE, null);
    const fileRunAt = toTimestamp(state?.lastRunAt);
    const lastRunAt = Math.max(fileRunAt ?? 0, memoryLastRunAt) || null;
    const lastResult = state?.lastResult && typeof state.lastResult === 'object' ? state.lastResult : null;
    return { lastRunAt, lastResult };
}

/**
 * Append deletions to the cleanup log (keeps the last 200 entries).
 * @param {CleanupDeletion[]} entries
 */
function appendCleanupLog(entries) {
    if (!entries.length) return;
    const current = readDataFile(LOG_FILE, []);
    const log = Array.isArray(current) ? current : [];
    log.push(...entries);
    writeDataFile(LOG_FILE, log.slice(-MAX_LOG_ENTRIES));
}

/**
 * Map items with bounded concurrency, preserving order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Storage used by an account (cached for 10 minutes; null when unknown).
 * @param {string} handle
 * @param {boolean} [fresh] Bypass the cache
 * @returns {Promise<number|null>}
 */
async function getStorageBytes(handle, fresh = false) {
    const cached = storageCache.get(handle);
    if (!fresh && cached && Date.now() - cached.at < STORAGE_CACHE_TTL_MS) return cached.bytes;
    const bytes = await calculateUserStorageAsync(handle);
    storageCache.set(handle, { bytes, at: Date.now() });
    return bytes;
}

/**
 * All live, QRole-linked, non-admin accounts (never default-user).
 * @returns {Promise<{handle: string, record: object, meta: object}[]>}
 */
async function collectQroleAccounts() {
    const linked = Object.entries(getAllUserMeta())
        .filter(([handle, meta]) => handle !== DEFAULT_USER_HANDLE && meta?.oauthProvider === 'qrole' && meta.oauthUserId);
    const accounts = await mapWithConcurrency(linked, RECORD_CONCURRENCY, async ([handle, meta]) => {
        const record = await storage.getItem(toKey(handle));
        if (!record || record.admin || !isMetaForRecord(meta, record)) return null;
        return { handle, record, meta };
    });
    return accounts.filter(Boolean);
}

/**
 * Current `oauth.qrole` config and lifecycle settings (read again during a run: an admin may switch
 * cleanup off or change the settings while it is running).
 * @returns {{cfg: object, lifecycle: import('./qrole-lifecycle.js').QroleLifecycleConfig}}
 */
function readRunSettings() {
    const cfg = getQroleConfig();
    return { cfg, lifecycle: resolveQroleLifecycleConfig(cfg) };
}

/**
 * Skip reason for an account that is (no longer) eligible.
 * @param {import('./qrole-lifecycle.js').CleanupEligibility} eligibility
 * @returns {'renewed'|'not_due'}
 */
function notEligibleReason(eligibility) {
    return eligibility.accountState.state === 'active' ? 'renewed' : 'not_due';
}

/**
 * Admin list entry of an account.
 * @param {{handle: string, record: object, meta: object}} account
 * @param {object} cfg `oauth.qrole` config
 * @param {import('./qrole-lifecycle.js').QroleLifecycleConfig} lifecycle
 * @param {number} now
 * @param {number|null} storageBytes
 * @param {boolean} [assumeCleanupEnabled] Report the cleanup date even while cleanup is off (preview)
 * @returns {QroleAccountEntry}
 */
function buildAccountEntry({ handle, record, meta }, cfg, lifecycle, now, storageBytes, assumeCleanupEnabled = false) {
    const accountState = getQroleAccountState(meta, cfg, now);
    const cleanup = assumeCleanupEnabled ? { ...lifecycle.expiredCleanup, enabled: true } : lifecycle.expiredCleanup;
    // Same rule as the user's own status (qrole-status.js): a token only counts while the feature
    // is on and the key file can decrypt it
    const tokenUsable = isRefreshTokenFeatureOn(lifecycle) && hasStoredRefreshToken(meta, now) && isTokenKeyAvailable();
    const tier = normalizeTier(meta.qroleTier);
    return {
        handle,
        name: typeof record.name === 'string' && record.name ? record.name : handle,
        enabled: record.enabled !== false,
        tier,
        tierName: typeof meta.qroleTierName === 'string' && meta.qroleTierName ? meta.qroleTierName : null,
        tierAllowed: isTierAllowed(tier, cfg),
        state: accountState.state,
        expiresAt: toTimestamp(meta.qroleMembershipExpiresAt),
        expiredSince: accountState.expiredSince,
        checkedAt: toTimestamp(meta.qroleCheckedAt),
        lastLoginAt: toTimestamp(meta.lastLoginAt),
        lastActiveAt: toTimestamp(meta.lastActiveAt),
        storageBytes,
        hasRefreshToken: tokenUsable,
        refreshTokenExpiresAt: tokenUsable ? meta.qroleRefreshTokenExpiresAt : null,
        cleanupAt: lifecycle.requireMembership ? computeCleanupAt(meta, accountState, cleanup) : null,
    };
}

/**
 * Sort: lapsed accounts first (longest lapsed first), then active ones by nearest expiry.
 * @param {QroleAccountEntry} a
 * @param {QroleAccountEntry} b
 * @returns {number}
 */
function compareEntries(a, b) {
    const lapsedA = a.state !== 'active' ? 0 : 1;
    const lapsedB = b.state !== 'active' ? 0 : 1;
    if (lapsedA !== lapsedB) return lapsedA - lapsedB;
    const keyA = (lapsedA === 0 ? a.expiredSince : a.expiresAt) ?? Number.MAX_SAFE_INTEGER;
    const keyB = (lapsedB === 0 ? b.expiredSince : b.expiresAt) ?? Number.MAX_SAFE_INTEGER;
    return keyA - keyB || a.handle.localeCompare(b.handle);
}

/**
 * Admin overview of all QRole accounts and the cleanup settings / last run.
 * @returns {Promise<{accounts: QroleAccountEntry[], cleanup: {enabled: boolean, afterDays: number, lastRunAt: number|null, lastResult: CleanupResult|null, running: boolean, runningSince: number|null}, now: number}>}
 */
export async function listQroleAccounts() {
    const cfg = getQroleConfig();
    const lifecycle = resolveQroleLifecycleConfig(cfg);
    const accounts = await collectQroleAccounts();
    const sizes = await mapWithConcurrency(accounts, STORAGE_CONCURRENCY, account => getStorageBytes(account.handle));
    const now = Date.now();
    const entries = accounts.map((account, index) => buildAccountEntry(account, cfg, lifecycle, now, sizes[index]));
    entries.sort(compareEntries);
    return {
        accounts: entries,
        cleanup: {
            enabled: lifecycle.expiredCleanup.enabled,
            afterDays: lifecycle.expiredCleanup.afterDays,
            ...getQroleCleanupStatus(),
        },
        now,
    };
}

/**
 * Whether a cleanup run is in progress, and the last finished run.
 * @returns {{running: boolean, runningSince: number|null, lastRunAt: number|null, lastResult: CleanupResult|null}}
 */
export function getQroleCleanupStatus() {
    const { lastRunAt, lastResult } = readCleanupState();
    return {
        running: runningCleanup !== null,
        runningSince: runningCleanup !== null ? runningSince : null,
        lastRunAt,
        lastResult,
    };
}

/**
 * Admin list entry of one account, or null when it is not a live QRole account.
 * @param {string} handle
 * @returns {Promise<QroleAccountEntry|null>}
 */
export async function getQroleAccountEntry(handle) {
    const account = await loadLiveQroleAccount(handle);
    if (!account || account.handle === DEFAULT_USER_HANDLE) return null;
    const cfg = getQroleConfig();
    const lifecycle = resolveQroleLifecycleConfig(cfg);
    const storageBytes = await getStorageBytes(account.handle);
    return buildAccountEntry(account, cfg, lifecycle, Date.now(), storageBytes);
}

/**
 * Accounts the next cleanup run would delete (all checks except the network re-verification),
 * computed with the configured afterDays even while cleanup is disabled.
 * @returns {Promise<{enabled: boolean, requireMembership: boolean, afterDays: number, maxPerRun: number, now: number, total: number, candidates: (QroleAccountEntry & {wouldVerify: boolean})[]}>}
 */
export async function previewQroleCleanup() {
    const cfg = getQroleConfig();
    const lifecycle = resolveQroleLifecycleConfig(cfg);
    const now = Date.now();
    const due = (await collectQroleAccounts())
        .map(account => ({ account, eligibility: getCleanupEligibility(account.meta, cfg, lifecycle, now) }))
        .filter(item => item.eligibility.eligible)
        .sort((a, b) => Number(a.eligibility.cleanupAt) - Number(b.eligibility.cleanupAt));
    const sizes = await mapWithConcurrency(due, STORAGE_CONCURRENCY, item => getStorageBytes(item.account.handle));
    // Same condition as the run: a stored token is always checked first (the account is skipped,
    // never deleted, when it cannot be checked, e.g. without a usable key file)
    const verifyOn = isRefreshTokenFeatureOn(lifecycle);
    const candidates = due.map((item, index) => ({
        ...buildAccountEntry(item.account, cfg, lifecycle, now, sizes[index], true),
        wouldVerify: verifyOn && hasStoredRefreshToken(item.account.meta, now),
    }));
    return {
        enabled: lifecycle.expiredCleanup.enabled,
        requireMembership: lifecycle.requireMembership,
        afterDays: lifecycle.expiredCleanup.afterDays,
        maxPerRun: MAX_DELETIONS_PER_RUN,
        now,
        total: candidates.length,
        candidates,
    };
}

/**
 * Copy of a result with bounded detail lists (for the state file).
 * @param {CleanupResult} result
 * @returns {CleanupResult}
 */
function summarizeResult(result) {
    return {
        ...result,
        deleted: result.deleted.slice(0, MAX_RESULT_DETAILS),
        skipped: result.skipped.slice(0, MAX_RESULT_DETAILS),
        failed: result.failed.slice(0, MAX_RESULT_DETAILS),
    };
}

/**
 * One cleanup run.
 * @param {'scheduler'|'manual'} trigger
 * @returns {Promise<CleanupResult>}
 */
async function executeCleanup(trigger) {
    const startedAt = Date.now();
    const cfg = getQroleConfig();
    const lifecycle = resolveQroleLifecycleConfig(cfg);
    /** @type {CleanupResult} */
    const result = {
        trigger,
        startedAt,
        finishedAt: null,
        afterDays: lifecycle.expiredCleanup.afterDays,
        candidates: 0,
        deletedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        remaining: 0,
        deleted: [],
        skipped: [],
        failed: [],
    };
    const skip = (handle, reason) => result.skipped.push({ handle, reason });

    try {
        const due = (await collectQroleAccounts())
            .map(account => ({ handle: account.handle, eligibility: getCleanupEligibility(account.meta, cfg, lifecycle, startedAt) }))
            .filter(item => item.eligibility.eligible)
            .sort((a, b) => Number(a.eligibility.cleanupAt) - Number(b.eligibility.cleanupAt));
        result.candidates = due.length;

        let verifications = 0;
        let consecutiveTransient = 0;
        // QRole rejected this site's client credentials: no account can be checked this run
        let clientRejected = false;
        for (let i = 0; i < due.length; i++) {
            if (result.deleted.length >= MAX_DELETIONS_PER_RUN) {
                result.remaining = due.length - i;
                break;
            }
            const settings = readRunSettings();
            if (!isCleanupActive(settings.lifecycle)) {
                result.stopped = 'disabled';
                result.remaining = due.length - i;
                break;
            }
            const { handle } = due[i];
            try {
                // Re-read record + metadata: the account may have been renewed, deleted or changed
                const account = await loadLiveQroleAccount(handle);
                if (!account) {
                    skip(handle, 'gone');
                    continue;
                }
                const eligibility = getCleanupEligibility(account.meta, settings.cfg, settings.lifecycle, Date.now());
                if (!eligibility.eligible) {
                    skip(handle, notEligibleReason(eligibility));
                    continue;
                }

                /** @type {string|null} */
                let verify = null;
                if (isRefreshTokenFeatureOn(settings.lifecycle) && hasStoredRefreshToken(account.meta, Date.now())) {
                    if (clientRejected) {
                        skip(handle, 'verify_client_rejected');
                        continue;
                    }
                    if (verifications >= MAX_VERIFICATIONS_PER_RUN || consecutiveTransient >= MAX_CONSECUTIVE_TRANSIENT) {
                        skip(handle, 'verify_deferred');
                        continue;
                    }
                    verifications++;
                    const outcome = await verifyQroleMembership(handle, { reason: 'cleanup' });
                    verify = outcome.result;
                    if (outcome.result === 'transient') {
                        if (outcome.reason === 'invalid_client') {
                            // A client-level rejection says nothing about the accounts
                            clientRejected = true;
                            skip(handle, 'verify_client_rejected');
                        } else {
                            consecutiveTransient++;
                            skip(handle, 'verify_transient');
                        }
                        continue;
                    }
                    consecutiveTransient = 0;
                    if (outcome.result === 'no_token') {
                        if (outcome.reason === 'no_account') {
                            // Deleted, unlinked, re-linked or made admin while QRole was being asked
                            skip(handle, 'gone');
                            continue;
                        }
                        if (outcome.reason === 'key_unavailable' || outcome.reason === 'disabled') {
                            // The token could not be checked at all: never delete on that basis
                            skip(handle, 'verify_unavailable');
                            continue;
                        }
                        // Token expired meanwhile or undecryptable: like an account without a token
                    }
                    if (outcome.result === 'ok') {
                        // Snapshot updated: a renewed account is skipped before the storage walk
                        const refreshed = await loadLiveQroleAccount(handle);
                        const recheck = refreshed && getCleanupEligibility(refreshed.meta, settings.cfg, settings.lifecycle, Date.now());
                        if (!recheck || !recheck.eligible) {
                            skip(handle, recheck ? notEligibleReason(recheck) : 'gone');
                            continue;
                        }
                    }
                }

                // Measured before the final check, so nothing slow runs between the check and the deletion
                const storageBytes = await getStorageBytes(handle, true);
                /** @type {{meta: object, eligibility: import('./qrole-lifecycle.js').CleanupEligibility}|null} */
                let checked = null;
                const deletion = await deleteUserWithLock(handle, {
                    // Final check under the deletion lock (logins of this account wait for it)
                    precheck: async () => {
                        const latest = readRunSettings();
                        const live = await loadLiveQroleAccount(handle);
                        const { veto, eligibility: latestEligibility } = checkCleanupStillDue({
                            ...latest,
                            meta: live?.meta ?? null,
                            oauthUserId: account.meta.oauthUserId,
                            now: Date.now(),
                        });
                        if (veto || !live || !latestEligibility) return veto || 'gone';
                        checked = { meta: live.meta, eligibility: latestEligibility };
                        return null;
                    },
                });
                if (deletion.skipped) {
                    skip(handle, deletion.skipped);
                    if (deletion.skipped === 'cleanup_disabled') {
                        result.stopped = 'disabled';
                        result.remaining = due.length - i - 1;
                        break;
                    }
                    continue;
                }
                storageCache.delete(handle);
                if (!deletion.success) {
                    result.failed.push({ handle, error: deletion.error || 'Unknown error' });
                    continue;
                }

                const final = checked || { meta: account.meta, eligibility };
                /** @type {CleanupDeletion} */
                const entry = {
                    at: Date.now(),
                    handle,
                    reason: stateToReason(final.eligibility.accountState.state),
                    expiresAt: toTimestamp(final.meta.qroleMembershipExpiresAt),
                    expiredSince: final.eligibility.accountState.expiredSince,
                    storageBytes,
                    verify,
                    trigger,
                };
                result.deleted.push(entry);
                appendCleanupLog([entry]);
                const expiry = entry.expiresAt ? new Date(entry.expiresAt).toISOString() : 'none';
                const size = storageBytes === null ? 'unknown' : `${Math.round(storageBytes / 1024 / 1024 * 100) / 100} MiB`;
                console.log(`[STC-MOD] QRole cleanup deleted account ${handle} (reason: ${entry.reason}, membership expiry: ${expiry}, storage: ${size}, verify: ${verify ?? 'no token'})`);
            } catch (error) {
                result.failed.push({ handle, error: error?.message || 'Unknown error' });
            }
        }
    } catch (error) {
        result.error = error?.message || 'Unknown error';
        console.error('[STC-MOD] QRole cleanup run failed:', result.error);
    }

    result.finishedAt = Date.now();
    result.deletedCount = result.deleted.length;
    result.skippedCount = result.skipped.length;
    result.failedCount = result.failed.length;
    memoryLastRunAt = startedAt;
    writeDataFile(STATE_FILE, { lastRunAt: startedAt, lastResult: summarizeResult(result) });
    if (result.candidates > 0 || result.error) {
        const stopped = result.stopped ? ' (stopped: cleanup was switched off)' : '';
        console.log(`[STC-MOD] QRole cleanup (${trigger}): ${result.deletedCount} deleted, ${result.skippedCount} skipped, ${result.failedCount} failed, ${result.remaining} left for the next run${stopped}`);
    }
    return result;
}

/**
 * Run the cleanup job now (scheduler and admin "立即执行清理" share this path).
 * @param {{trigger?: 'scheduler'|'manual', background?: boolean}} [opts] background: return as soon
 *   as the run started (the admin panel then polls the account list for `cleanup.running` and the
 *   last result, so a long run never hits a reverse-proxy timeout)
 * @returns {Promise<{started: false, reason: 'running'|'disabled'|'membership_not_required'}|{started: true, result: CleanupResult}|{started: true, background: true, startedAt: number}>}
 */
export async function runQroleCleanup({ trigger = 'manual', background = false } = {}) {
    if (runningCleanup) return { started: false, reason: 'running' };
    const lifecycle = resolveQroleLifecycleConfig(getQroleConfig());
    if (!lifecycle.requireMembership) return { started: false, reason: 'membership_not_required' };
    if (!lifecycle.expiredCleanup.enabled) return { started: false, reason: 'disabled' };

    const startedAt = Date.now();
    runningSince = startedAt;
    const run = executeCleanup(trigger);
    runningCleanup = run;
    const finished = run.finally(() => {
        if (runningCleanup === run) {
            runningCleanup = null;
            runningSince = null;
        }
    });
    if (background) {
        finished.catch(error => console.error('[STC-MOD] QRole cleanup run failed:', error?.message || error));
        return { started: true, background: true, startedAt };
    }
    return { started: true, result: await finished };
}

/**
 * Scheduler tick: run when enabled and the last run is at least 24 h ago.
 * @returns {Promise<void>}
 */
async function scheduledTick() {
    const lifecycle = resolveQroleLifecycleConfig(getQroleConfig());
    if (!lifecycle.expiredCleanup.enabled || !lifecycle.requireMembership) return;
    const { lastRunAt } = readCleanupState();
    const elapsed = Date.now() - (lastRunAt ?? 0);
    if (lastRunAt && elapsed >= 0 && elapsed < RUN_INTERVAL_MS) return;
    await runQroleCleanup({ trigger: 'scheduler' });
}

/**
 * Start the hourly scheduler check (once per process; timers do not keep the process alive).
 */
export function startQroleCleanupScheduler() {
    if (schedulerStarted) return;
    schedulerStarted = true;
    const tick = () => {
        scheduledTick().catch(error => console.error('[STC-MOD] QRole cleanup scheduler error:', error?.message || error));
    };
    setTimeout(tick, INITIAL_CHECK_DELAY_MS).unref();
    setInterval(tick, CHECK_INTERVAL_MS).unref();
}
