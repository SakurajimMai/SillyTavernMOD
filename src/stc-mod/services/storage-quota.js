/**
 * SillyTavernchat Module - Storage Quota Service
 * Manages user storage limits, the per-user usage cache (asynchronous accounting, see
 * "Usage accounting" below), check-in rewards, and expansion codes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getStcConfig, getStcDataDir, getDataRoot } from '../config.js';
import { getUserMeta, setUserMeta } from '../user-metadata.js';
import { StoreUnavailableError, createJsonStore, getDataRootGuardState } from './json-store.js';

const STORAGE_CODES_FILE = 'storage-codes.json';

export function isStorageLimitEnabled() {
    return !!getStcConfig('userStorage.enabled', false);
}

export function getDefaultLimitMiB() {
    return getStcConfig('userStorage.defaultLimitMiB', 500);
}

export function getDailyCheckInMiB() {
    return getStcConfig('userStorage.dailyCheckInMiB', 0);
}

// --- Usage accounting ---
//
// The bytes under a user's data directory are counted by an asynchronous walk (never synchronously
// on a request path) and cached per user: { bytes, categories, computedAt, pendingBytes }.
// - A value is fresh for USAGE_FRESH_MS; a stale or missing value is recomputed, single-flight per
//   user. Callers on request paths wait a bounded time and otherwise get the stale / unknown value.
// - A walk error (EIO, ENOTCONN, EACCES, a missing user directory, a lost data root mount per the
//   json-store.js guard, ...) yields `null` = unknown, never 0; the next attempt waits
//   USAGE_ERROR_RETRY_MS.
// - A walk still running after USAGE_WALK_TIMEOUT_MS (huge directory, hanging FUSE mount) is
//   "overdue": callers stop waiting for it (a user never counted so far stays unknown with error
//   ETIMEDOUT, a stale value stays in use), but it keeps its single-flight slot until it settles, so
//   counts of the same user never pile up, and its late result is cached.
// - Successful writes add their size to `pendingBytes` (an upper bound of the growth) and schedule
//   a recount within RECOUNT_AFTER_WRITE_MS (not postponed by later writes); deletions and renames
//   schedule a recount within RECOUNT_AFTER_FREE_MS. A finished walk only clears the pending bytes
//   that were recorded before it started.
// - All walks share one limiter of concurrent filesystem operations (USAGE_FS_CONCURRENCY, below
//   the libuv threadpool size so other asynchronous file I/O always finds a free thread); a walk
//   keeps at most that many operations in flight and holds only the listings of the directories it
//   is working on (no per-file closures up front). Admin lists refresh at most
//   USAGE_LIST_CONCURRENCY users at once and return after a deadline with partial results (the
//   walks continue in the background and fill the cache).

const MiB = 1024 * 1024;
/** A counted value is used without recounting for this long (ms). */
export const USAGE_FRESH_MS = 10 * 60 * 1000;
/** After a failed walk, the next automatic attempt waits this long (ms). */
export const USAGE_ERROR_RETRY_MS = 30 * 1000;
/** Recount this long after the first write that added pending bytes (ms). */
export const RECOUNT_AFTER_WRITE_MS = 30 * 1000;
/** Recount this long after a deletion / rename (ms). */
export const RECOUNT_AFTER_FREE_MS = 1500;
/** Quota enforcement waits at most this long for a recount before using the stale / unknown value (ms). */
export const ENFORCE_WAIT_MS = 8000;
/** Per-user info endpoints (/me-ext, /storage, /can-write) wait at most this long (ms). */
export const INFO_WAIT_MS = 3000;
/** Admin lists return after this long with partial results (ms). */
export const LIST_DEADLINE_MS = 5000;
/** Users walked at once for admin lists. */
export const USAGE_LIST_CONCURRENCY = 4;
/** Threads of the libuv threadpool that runs fs.promises calls (UV_THREADPOOL_SIZE, default 4). */
const THREADPOOL_SIZE = (() => {
    const size = Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '', 10);
    return Number.isFinite(size) && size > 0 ? size : 4;
})();
/**
 * Concurrent filesystem operations of all usage walks together: one less than the threadpool size
 * (at most 16), so request handling and the data root watchdog never wait behind a whole pool of
 * walk operations. Raise UV_THREADPOOL_SIZE to count faster.
 */
export const USAGE_FS_CONCURRENCY = Math.max(1, Math.min(16, THREADPOOL_SIZE - 1));
/** A walk still running after this long is overdue: nobody waits for it any more (ms). */
export const USAGE_WALK_TIMEOUT_MS = 2 * 60 * 1000;
const WALK_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Limit the number of concurrently running async operations (FIFO, O(1) per operation).
 * @param {number} max
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(max) {
    let active = 0;
    /** @type {({fn: () => Promise<any>, resolve: (v: any) => void, reject: (e: any) => void}|undefined)[]} */
    let waiting = [];
    // Index of the next job: Array#shift would copy the whole queue on every dequeue
    let head = 0;
    const pump = () => {
        while (active < max && head < waiting.length) {
            const job = waiting[head];
            waiting[head++] = undefined;
            if (head >= 1024 && head * 2 >= waiting.length) {
                waiting = waiting.slice(head);
                head = 0;
            }
            if (!job) continue;
            const { fn, resolve, reject } = job;
            active++;
            Promise.resolve()
                .then(fn)
                .then(resolve, reject)
                .finally(() => {
                    active--;
                    pump();
                });
        }
    };
    return fn => new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject });
        pump();
    });
}

const fsLimiter = createLimiter(USAGE_FS_CONCURRENCY);

/**
 * Error of a walk stopped through its AbortSignal.
 * @param {AbortSignal} signal
 * @returns {Error}
 */
function abortError(signal) {
    const reason = signal.reason;
    if (reason instanceof Error) return reason;
    return Object.assign(new Error('usage walk aborted'), { code: 'ABORT_ERR' });
}

/**
 * Total size of the regular files under a directory (symlinks are not followed), grouped by the
 * top-level entry they belong to ('' = files directly in the directory).
 * Entries removed while walking are skipped; any other error (including a missing root) rejects.
 * At most `width` operations of this walk are in flight (each through `limit`); only the listings of
 * the directories being worked on are held in memory (depth first, files before subdirectories).
 * @param {string} rootDir
 * @param {{fsp?: Pick<typeof fs.promises, 'readdir'|'stat'>, limit?: <T>(fn: () => Promise<T>) => Promise<T>, width?: number, signal?: AbortSignal}} [opts]
 *   signal: stops the walk before its next operation (rejects with the abort reason)
 * @returns {Promise<{bytes: number, categories: Record<string, number>}>}
 */
export async function measureDirectory(rootDir, { fsp = fs.promises, limit = fsLimiter, width = USAGE_FS_CONCURRENCY, signal } = {}) {
    let bytes = 0;
    /** @type {Record<string, number>} */
    const categories = Object.create(null);
    /** Directories still to list (a stack: depth first keeps few listings open). */
    /** @type {{dir: string, top: string|null}[]} */
    const dirs = [{ dir: rootDir, top: null }];
    /** Listings whose files are still to be stat'ed (the newest last). */
    /** @type {{dir: string, top: string|null, entries: import('node:fs').Dirent[], next: number}[]} */
    const listings = [];
    let busy = 0;
    /** @type {unknown} */
    let failure = null;
    /** @type {(() => void)[]} */
    let idle = [];

    const wake = () => {
        const waiters = idle;
        idle = [];
        for (const resume of waiters) resume();
    };

    const nextFile = () => {
        while (listings.length) {
            const listing = listings[listings.length - 1];
            while (listing.next < listing.entries.length) {
                const entry = listing.entries[listing.next++];
                if (entry.isFile()) return { file: path.join(listing.dir, entry.name), key: listing.top ?? '' };
            }
            listings.pop();
        }
        return null;
    };

    /** @param {{dir: string, top: string|null}} item */
    const listDirectory = async ({ dir, top }) => {
        let entries;
        try {
            entries = await limit(() => fsp.readdir(dir, { withFileTypes: true }));
        } catch (error) {
            if (top !== null && error?.code === 'ENOENT') return; // removed while walking
            throw error;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) dirs.push({ dir: path.join(dir, entry.name), top: top ?? entry.name });
        }
        listings.push({ dir, top, entries, next: 0 });
    };

    /** @param {{file: string, key: string}} item */
    const statFile = async ({ file, key }) => {
        let stat;
        try {
            stat = await limit(() => fsp.stat(file));
        } catch (error) {
            if (error?.code === 'ENOENT') return; // removed while walking
            throw error;
        }
        bytes += stat.size;
        categories[key] = (categories[key] || 0) + stat.size;
    };

    const runWorker = async () => {
        for (;;) {
            if (failure) return;
            if (signal?.aborted) {
                failure = abortError(signal);
                wake();
                return;
            }
            const file = nextFile();
            const dir = file ? null : dirs.pop();
            if (!file && !dir) {
                // Nothing to take: done when nobody else can produce more work
                if (busy === 0) {
                    wake();
                    return;
                }
                await new Promise(resolve => idle.push(resolve));
                continue;
            }
            busy++;
            try {
                await (file ? statFile(file) : listDirectory(/** @type {{dir: string, top: string|null}} */ (dir)));
            } catch (error) {
                failure ??= error;
            } finally {
                busy--;
                wake();
            }
        }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.floor(width) || 1) }, runWorker));
    if (failure) throw failure;
    return { bytes, categories: { ...categories } };
}

/**
 * @typedef {Object} UsageSnapshot
 * @property {number|null} bytes Last counted size (null = unknown: never counted, or the last walk failed)
 * @property {number} pendingBytes Upper bound of the bytes written since that count
 * @property {Record<string, number>|null} categories Counted bytes per top-level entry
 * @property {number|null} computedAt When `bytes` was counted
 * @property {boolean} fresh `bytes` is known and not older than the freshness window
 * @property {boolean} unknown `bytes` is null
 * @property {boolean} computing A count is running or queued
 * @property {string|null} error Code of the last failed walk (while unknown)
 */

const TIMED_OUT = Symbol('timed-out');

/**
 * Per-user usage cache (see the section comment). Exported for tests; the module uses one instance.
 * @param {Object} opts
 * @param {(handle: string, opts: {signal?: AbortSignal}) => Promise<{bytes: number, categories?: Record<string, number>}>} opts.walk
 *   `signal` is aborted when the count is discarded (invalidate)
 * @param {() => number} [opts.now]
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer]
 * @param {(timer: any) => void} [opts.clearTimer]
 * @param {number} [opts.freshMs]
 * @param {number} [opts.errorRetryMs]
 * @param {number} [opts.writeRecountMs]
 * @param {number} [opts.freeRecountMs]
 * @param {number} [opts.listConcurrency]
 * @param {number} [opts.walkTimeoutMs] A count running this long is overdue (nobody waits for it)
 * @param {(handle: string, error: any) => void} [opts.onWalkError]
 */
export function createUsageTracker({
    walk,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = timer => clearTimeout(timer),
    freshMs = USAGE_FRESH_MS,
    errorRetryMs = USAGE_ERROR_RETRY_MS,
    writeRecountMs = RECOUNT_AFTER_WRITE_MS,
    freeRecountMs = RECOUNT_AFTER_FREE_MS,
    listConcurrency = USAGE_LIST_CONCURRENCY,
    walkTimeoutMs = USAGE_WALK_TIMEOUT_MS,
    onWalkError = () => {},
}) {
    /** @type {Map<string, {bytes: number|null, categories: Record<string, number>|null, computedAt: number, pendingBytes: number, errorAt: number, error: string|null}>} */
    const cache = new Map();
    /**
     * Running counts (single-flight: one per user until the walk settles, also when overdue).
     * @type {Map<string, {promise: Promise<UsageSnapshot>, startedAt: number, epoch: number, overdue: boolean, controller: AbortController|null, timer: any}>}
     */
    const inflight = new Map();
    /** Bumped by invalidate(): results of walks started before are discarded. */
    /** @type {Map<string, number>} */
    const epochs = new Map();
    /** @type {Map<string, {timer: any, dueAt: number}>} */
    const recountTimers = new Map();
    /** Background refresh queue of admin lists. */
    /** @type {string[]} */
    const queue = [];
    /** @type {Map<string, {promise: Promise<void>, resolve: () => void, maxAgeMs: number}>} */
    const queued = new Map();
    let queueActive = 0;

    const ensureEntry = (handle) => {
        let entry = cache.get(handle);
        if (!entry) {
            entry = { bytes: null, categories: null, computedAt: 0, pendingBytes: 0, errorAt: 0, error: null };
            cache.set(handle, entry);
        }
        return entry;
    };

    const isFresh = (entry, maxAgeMs) => !!entry && entry.bytes !== null && now() - entry.computedAt <= maxAgeMs;
    const inErrorBackoff = entry => !!entry && entry.bytes === null && entry.errorAt > 0 && now() - entry.errorAt < errorRetryMs;
    const hasTimeout = Number.isFinite(walkTimeoutMs);

    /**
     * @param {string} handle
     * @returns {UsageSnapshot}
     */
    function peek(handle) {
        const entry = cache.get(handle);
        const bytes = entry ? entry.bytes : null;
        return {
            bytes,
            pendingBytes: entry?.pendingBytes || 0,
            categories: bytes !== null ? entry.categories : null,
            computedAt: bytes !== null ? entry.computedAt : null,
            fresh: isFresh(entry, freshMs),
            unknown: bytes === null,
            computing: inflight.has(handle) || queued.has(handle),
            error: bytes === null ? (entry?.error ?? null) : null,
        };
    }

    /**
     * A count ran past walkTimeoutMs: flag it (callers stop waiting; an unknown value reports ETIMEDOUT).
     * @param {string} handle
     * @param {{overdue: boolean, epoch: number}} job
     */
    function markOverdue(handle, job) {
        if (job.overdue || inflight.get(handle) !== job) return;
        job.overdue = true;
        if ((epochs.get(handle) || 0) !== job.epoch) return;
        const entry = ensureEntry(handle);
        entry.error = 'ETIMEDOUT';
        const error = new Error(`usage walk still running after ${walkTimeoutMs} ms`);
        // @ts-ignore
        error.code = 'ETIMEDOUT';
        onWalkError(handle, error);
    }

    /**
     * @param {{overdue: boolean, startedAt: number}} job
     * @returns {boolean}
     */
    const isOverdue = job => job.overdue || (hasTimeout && now() - job.startedAt >= walkTimeoutMs);

    /**
     * Count now (single-flight: joins a running count, also an overdue one). Never rejects; settles
     * when the walk settles.
     * @param {string} handle
     * @returns {Promise<UsageSnapshot>}
     */
    function refresh(handle) {
        const running = inflight.get(handle);
        if (running) return running.promise;
        const epoch = epochs.get(handle) || 0;
        const pendingAtStart = cache.get(handle)?.pendingBytes || 0;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const job = { promise: /** @type {Promise<UsageSnapshot>} */ (/** @type {unknown} */ (null)), startedAt: now(), epoch, overdue: false, controller, timer: null };
        // Before taking the snapshot, so it does not report this finished count as running
        const release = () => {
            if (inflight.get(handle) === job) inflight.delete(handle);
            if (job.timer) {
                clearTimer(job.timer);
                job.timer = null;
            }
        };
        job.promise = (async () => {
            let result = null;
            let failure = null;
            try {
                result = await walk(handle, { signal: controller?.signal });
                if (!result || !Number.isFinite(result.bytes) || result.bytes < 0) {
                    throw new Error('invalid usage result');
                }
            } catch (error) {
                failure = error || new Error('usage walk failed');
                result = null;
            }
            release();
            if ((epochs.get(handle) || 0) !== epoch) return peek(handle); // invalidated meanwhile
            const entry = ensureEntry(handle);
            if (result) {
                // Also a late result of an overdue count
                entry.bytes = result.bytes;
                entry.categories = result.categories || null;
                entry.computedAt = now();
                entry.errorAt = 0;
                entry.error = null;
                // Writes recorded while the walk ran stay pending (the walk may have missed them)
                entry.pendingBytes = Math.max(0, entry.pendingBytes - pendingAtStart);
            } else {
                entry.bytes = null;
                entry.categories = null;
                entry.errorAt = now();
                entry.error = String(failure?.code || failure?.message || 'error');
                onWalkError(handle, failure);
            }
            return peek(handle);
        })().finally(release);
        inflight.set(handle, job);
        if (hasTimeout) {
            job.timer = setTimer(() => {
                job.timer = null;
                markOverdue(handle, job);
            }, Math.max(0, walkTimeoutMs));
            job.timer?.unref?.();
        }
        return job.promise;
    }

    /**
     * @template T
     * @param {Promise<T>} promise
     * @param {number} ms
     * @returns {Promise<T|typeof TIMED_OUT>}
     */
    function withTimeout(promise, ms) {
        if (!Number.isFinite(ms)) return promise;
        return new Promise((resolve) => {
            const timer = setTimer(() => resolve(TIMED_OUT), Math.max(0, ms));
            timer?.unref?.();
            promise.then((value) => {
                clearTimer(timer);
                resolve(value);
            }, () => {
                clearTimer(timer);
                resolve(TIMED_OUT);
            });
        });
    }

    /**
     * Usage of a user: the cached value when fresh, otherwise a (single-flight) recount awaited for
     * at most `waitMs` and never past the point where the count becomes overdue (then the stale /
     * unknown value is returned and the count goes on). During the error backoff, or while an
     * overdue count runs, the current value is returned without waiting or a new walk.
     * @param {string} handle
     * @param {{maxAgeMs?: number, waitMs?: number}} [opts]
     * @returns {Promise<UsageSnapshot>}
     */
    async function get(handle, { maxAgeMs = freshMs, waitMs = Infinity } = {}) {
        const entry = cache.get(handle);
        if (isFresh(entry, maxAgeMs)) return peek(handle);
        const running = inflight.get(handle);
        if (!running && inErrorBackoff(entry)) return peek(handle);
        if (running && isOverdue(running)) {
            markOverdue(handle, running);
            return peek(handle);
        }
        const promise = refresh(handle);
        const job = inflight.get(handle);
        let wait = waitMs;
        let untilOverdue = Infinity;
        if (job && hasTimeout) {
            untilOverdue = Math.max(0, walkTimeoutMs - (now() - job.startedAt));
            wait = Math.min(waitMs, untilOverdue);
        }
        const outcome = await withTimeout(promise, wait);
        if (outcome !== TIMED_OUT) return outcome;
        if (job && untilOverdue <= waitMs) markOverdue(handle, job);
        return peek(handle);
    }

    const pumpQueue = () => {
        while (queueActive < listConcurrency && queue.length) {
            const handle = queue.shift();
            const job = queued.get(handle);
            queueActive++;
            get(handle, { maxAgeMs: job.maxAgeMs }).catch(() => {}).finally(() => {
                queueActive--;
                queued.delete(handle);
                job.resolve();
                pumpQueue();
            });
        }
    };

    /**
     * Queue a background count (at most `listConcurrency` users at once, deduplicated).
     * @param {string} handle
     * @param {number} maxAgeMs
     * @returns {Promise<void>}
     */
    function enqueue(handle, maxAgeMs) {
        const existing = queued.get(handle);
        if (existing) return existing.promise;
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        queued.set(handle, { promise, resolve, maxAgeMs });
        queue.push(handle);
        pumpQueue();
        return promise;
    }

    /**
     * Usage of many users for admin lists: stale values are recounted in the background (bounded
     * concurrency); returns when all are done or after `deadlineMs` with partial results.
     * @param {string[]} handles
     * @param {{deadlineMs?: number, maxAgeMs?: number}} [opts]
     * @returns {Promise<Map<string, UsageSnapshot>>}
     */
    async function getMany(handles, { deadlineMs = LIST_DEADLINE_MS, maxAgeMs = freshMs } = {}) {
        const unique = [...new Set(handles)];
        const waits = [];
        for (const handle of unique) {
            const entry = cache.get(handle);
            if (isFresh(entry, maxAgeMs)) continue;
            if (!inflight.has(handle) && inErrorBackoff(entry)) continue;
            waits.push(enqueue(handle, maxAgeMs));
        }
        if (waits.length) await withTimeout(Promise.all(waits), deadlineMs);
        return new Map(unique.map(handle => [handle, peek(handle)]));
    }

    /**
     * Recount within `delayMs` (an earlier scheduled recount is kept). A count that is running
     * when the timer fires may have missed the change, so another one follows it.
     * @param {string} handle
     * @param {number} delayMs
     */
    function scheduleRecount(handle, delayMs) {
        const dueAt = now() + delayMs;
        const existing = recountTimers.get(handle);
        if (existing && existing.dueAt <= dueAt) return;
        if (existing) clearTimer(existing.timer);
        const timer = setTimer(() => {
            if (recountTimers.get(handle)?.timer !== timer) return;
            recountTimers.delete(handle);
            const running = inflight.get(handle);
            if (running) {
                running.promise.then(() => scheduleRecount(handle, 0));
                return;
            }
            refresh(handle);
        }, Math.max(0, delayMs));
        timer?.unref?.();
        recountTimers.set(handle, { timer, dueAt });
    }

    /**
     * A write of at most `bytes` bytes succeeded.
     * @param {string} handle
     * @param {number} bytes
     */
    function recordWrite(handle, bytes) {
        const entry = ensureEntry(handle);
        entry.pendingBytes += Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
        scheduleRecount(handle, writeRecountMs);
    }

    /**
     * A deletion / rename succeeded: recount soon (only when a value is cached or being counted).
     * @param {string} handle
     */
    function recordFree(handle) {
        if (!cache.has(handle) && !inflight.has(handle)) return;
        scheduleRecount(handle, freeRecountMs);
    }

    /**
     * Forget everything about a user (deleted / reset / limit changed); running counts are discarded
     * (and aborted: they stop before their next filesystem operation).
     * @param {string} handle
     */
    function invalidate(handle) {
        epochs.set(handle, (epochs.get(handle) || 0) + 1);
        cache.delete(handle);
        const running = inflight.get(handle);
        if (running) {
            inflight.delete(handle);
            if (running.timer) clearTimer(running.timer);
            running.controller?.abort();
        }
        const timer = recountTimers.get(handle);
        if (timer) {
            clearTimer(timer.timer);
            recountTimers.delete(handle);
        }
    }

    function invalidateAll() {
        for (const handle of new Set([...cache.keys(), ...inflight.keys(), ...recountTimers.keys()])) {
            invalidate(handle);
        }
    }

    return { peek, refresh, get, getMany, recordWrite, recordFree, scheduleRecount, invalidate, invalidateAll };
}

/**
 * Refuse (StoreUnavailableError) when the data root mount is gone: the watchdog declared it lost, or
 * the data root now has another device id (checked asynchronously, so a hanging mount does not
 * block the event loop), since the paths then resolve to the empty underlying directory.
 * @returns {Promise<void>}
 */
async function assertDataRootUsableAsync() {
    const guard = getDataRootGuardState();
    if (guard.lostReason) throw new StoreUnavailableError(guard.lostReason);
    if (guard.mounted && guard.dev !== null) {
        const stat = await fs.promises.stat(guard.anchor);
        if (stat.dev !== guard.dev) {
            throw new StoreUnavailableError(`data root ${guard.anchor} changed device (${guard.dev} -> ${stat.dev})`);
        }
    }
}

/**
 * Count a user's data directory; the data root is checked before and after the walk (a mount lost
 * while walking makes the rest of the tree look removed: that count is unknown, not a small value).
 * @param {string} handle
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{bytes: number, categories: Record<string, number>}>}
 */
async function walkUserDirectory(handle, { signal } = {}) {
    await assertDataRootUsableAsync();
    const result = await measureDirectory(path.join(getDataRoot(), handle), { signal });
    await assertDataRootUsableAsync();
    return result;
}

/** @type {Map<string, number>} */
const lastWalkErrorLog = new Map();

const usageTracker = createUsageTracker({
    walk: walkUserDirectory,
    onWalkError: (handle, error) => {
        const last = lastWalkErrorLog.get(handle) || 0;
        if (Date.now() - last < WALK_ERROR_LOG_INTERVAL_MS) return;
        lastWalkErrorLog.set(handle, Date.now());
        console.warn(`[STC-MOD] Storage usage of "${handle}" could not be counted (${error?.code || error?.message || error}); treated as unknown`);
    },
});

/**
 * Usage of a user (see createUsageTracker().get). Never walks synchronously.
 * @param {string} handle
 * @param {{maxAgeMs?: number, waitMs?: number}} [opts]
 * @returns {Promise<UsageSnapshot>}
 */
export function getUserUsage(handle, opts) {
    return usageTracker.get(handle, opts);
}

/**
 * Usage of many users with a deadline (partial results; see createUsageTracker().getMany).
 * @param {string[]} handles
 * @param {{deadlineMs?: number, maxAgeMs?: number}} [opts]
 * @returns {Promise<Map<string, UsageSnapshot>>}
 */
export function getUsersUsage(handles, opts) {
    return usageTracker.getMany(handles, opts);
}

/**
 * Cached usage without waiting; a stale / missing value is recounted in the background.
 * @param {string} handle
 * @returns {UsageSnapshot}
 */
export function peekUserUsage(handle) {
    const snapshot = usageTracker.peek(handle);
    if (!snapshot.fresh && !snapshot.computing) {
        usageTracker.get(handle).catch(() => {});
    }
    return snapshot;
}

/**
 * A write of at most `bytes` bytes by the user succeeded (adds pending bytes, schedules a recount).
 * @param {string} handle
 * @param {number} bytes
 */
export function recordUserWrite(handle, bytes) {
    usageTracker.recordWrite(handle, bytes);
}

/**
 * A deletion / rename by the user succeeded (prompt recount when a value is cached).
 * @param {string} handle
 */
export function recordUserFree(handle) {
    usageTracker.recordFree(handle);
}

/**
 * Drop the cached usage of a user (deletion, reset, limit change).
 * @param {string} handle
 */
export function invalidateUserUsage(handle) {
    usageTracker.invalidate(handle);
}

/** Drop all cached usage (e.g. the quota feature was switched on again). */
export function invalidateAllUsage() {
    usageTracker.invalidateAll();
}

/**
 * Storage used by a user in bytes, counted now (joins a running count).
 * @param {string} handle
 * @returns {Promise<number|null>} null when it cannot be determined
 */
export async function calculateUserStorageAsync(handle) {
    return (await usageTracker.get(handle, { maxAgeMs: 0 })).bytes;
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * Storage limit of a user in MiB.
 * @param {string} handle
 * @returns {number}
 */
export function getUserLimitMiB(handle) {
    const meta = getUserMeta(handle) || {};
    return meta.storageLimitMiB || getDefaultLimitMiB();
}

/**
 * Storage info of a user from a usage snapshot. Unknown usage never blocks writes.
 * Fields: enabled, limitMiB, usedMiB, remainingMiB, percent, canWrite, lastCheckInDate,
 * dailyCheckInMiB (unchanged) + unknown (usedMiB/remainingMiB/percent are null), pending (the figure
 * is being recounted, older than the freshness window or includes estimated recent writes),
 * pendingMiB, computedAt.
 * @param {string} handle
 * @param {UsageSnapshot} usage
 */
export function buildStorageInfo(handle, usage) {
    const meta = getUserMeta(handle) || {};
    const limitMiB = meta.storageLimitMiB || getDefaultLimitMiB();
    const base = {
        enabled: true,
        limitMiB,
        lastCheckInDate: meta.storageLastCheckInDate || null,
        dailyCheckInMiB: getDailyCheckInMiB(),
    };
    if (!usage || usage.bytes === null) {
        return {
            ...base,
            usedMiB: null,
            remainingMiB: null,
            percent: null,
            canWrite: true,
            unknown: true,
            pending: !!usage?.computing,
            pendingMiB: 0,
            computedAt: null,
        };
    }
    const pendingBytes = usage.pendingBytes || 0;
    const usedMiB = round2((usage.bytes + pendingBytes) / MiB);
    return {
        ...base,
        usedMiB,
        remainingMiB: Math.max(0, round2(limitMiB - usedMiB)),
        percent: limitMiB > 0 ? Math.round((usedMiB / limitMiB) * 100) : 0,
        canWrite: usedMiB < limitMiB,
        unknown: false,
        pending: pendingBytes > 0 || !usage.fresh || !!usage.computing,
        pendingMiB: round2(pendingBytes / MiB),
        computedAt: usage.computedAt,
    };
}

/**
 * Get storage info for a user (asynchronous; waits at most `waitMs` for a recount).
 * @param {string} handle
 * @param {{waitMs?: number, maxAgeMs?: number}} [opts] maxAgeMs: 0 = count now
 */
export async function getUserStorageInfoAsync(handle, { waitMs = INFO_WAIT_MS, maxAgeMs = USAGE_FRESH_MS } = {}) {
    if (!isStorageLimitEnabled()) {
        return { enabled: false };
    }
    return buildStorageInfo(handle, await getUserUsage(handle, { waitMs, maxAgeMs }));
}

/**
 * Get storage info for a user from the cache only (never walks the directory; a stale value is
 * recounted in the background). Prefer getUserStorageInfoAsync.
 * @param {string} handle
 */
export function getUserStorageInfo(handle) {
    if (!isStorageLimitEnabled()) {
        return { enabled: false };
    }
    return buildStorageInfo(handle, peekUserUsage(handle));
}

/**
 * Check if user can write (has available storage; unknown usage counts as writable).
 * @param {string} handle
 * @param {{waitMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function canUserWriteAsync(handle, opts) {
    if (!isStorageLimitEnabled()) return true;
    return (await getUserStorageInfoAsync(handle, opts)).canWrite;
}

/**
 * Check if user can write, from the cache only (see getUserStorageInfo). Prefer canUserWriteAsync.
 * @param {string} handle
 * @returns {boolean}
 */
export function canUserWrite(handle) {
    if (!isStorageLimitEnabled()) return true;
    return getUserStorageInfo(handle).canWrite;
}

/**
 * Perform daily check-in for storage reward
 */
export function dailyCheckIn(handle) {
    const reward = getDailyCheckInMiB();
    if (reward <= 0) return { success: false, reason: '签到奖励未开启' };

    const meta = getUserMeta(handle) || {};
    const today = new Date().toISOString().split('T')[0];

    if (meta.storageLastCheckInDate === today) {
        return { success: false, reason: '今日已签到' };
    }

    const currentLimit = meta.storageLimitMiB || getDefaultLimitMiB();
    setUserMeta(handle, {
        storageLimitMiB: currentLimit + reward,
        storageLastCheckInDate: today,
    });

    return {
        success: true,
        addedMiB: reward,
        newLimitMiB: currentLimit + reward,
    };
}

// --- Storage Expansion Codes ---
//
// `storage-codes.json` (JSON array) in the STC data dir, through json-store.js: a missing file is
// an empty list, an unparseable one is recovered from `.bak` or kept as `.corrupt-<ts>`, and any
// other read error throws StoreUnavailableError (HTTP 503) instead of looking like "no codes".

const codesStore = createJsonStore({
    label: 'Storage codes',
    file: () => path.join(getStcDataDir(), STORAGE_CODES_FILE),
    validate: Array.isArray,
    empty: () => [],
});

/**
 * Generate storage expansion codes.
 * @param {number} count
 * @param {number} amountMiB
 * @param {string} createdBy
 * @returns {object[]} The new codes
 * @throws {StoreUnavailableError}
 */
export function generateStorageCodes(count, amountMiB, createdBy) {
    const newCodes = [];
    for (let i = 0; i < count; i++) {
        newCodes.push({
            code: crypto.randomBytes(6).toString('hex').toUpperCase(),
            amountMiB,
            createdBy,
            createdAt: Date.now(),
            used: false,
            usedBy: null,
            usedAt: null,
        });
    }
    codesStore.update((codes) => {
        codes.push(...newCodes);
    });
    return newCodes;
}

/**
 * Redeem a storage expansion code: the metadata is read first (StoreUnavailableError while it is
 * unavailable, nothing consumed), then the code is marked used, then the limit is raised and saved
 * at once. When that save fails (e.g. the mount vanished between the two writes) the raised limit
 * stays pending in memory (retried), an error naming the user and the code is logged and the result
 * has `persisted: false`: if the process stops before the retry succeeds, the code is used up
 * without the raised limit on disk.
 * @param {string} code
 * @param {string} handle
 * @returns {{success: boolean, reason?: string, addedMiB?: number, newLimitMiB?: number}}
 * @throws {StoreUnavailableError}
 */
export function useStorageCode(code, handle) {
    if (!code || typeof code !== 'string') return { success: false, reason: '激活码无效或已使用' };
    const upperCode = code.toUpperCase();
    // Throws while the metadata store is unavailable (nothing consumed yet)
    getUserMeta(handle);
    const now = Date.now();

    const storageCode = codesStore.update((codes) => {
        const idx = codes.findIndex(c => c.code === upperCode && !c.used);
        if (idx === -1) return null;
        const found = codes[idx];
        codes[idx] = { ...found, used: true, usedBy: handle, usedAt: now };
        return found;
    });
    if (!storageCode) return { success: false, reason: '激活码无效或已使用' };

    // Read again after the code store update: the limit may have changed meanwhile (check-in)
    const meta = getUserMeta(handle) || {};
    const currentLimit = meta.storageLimitMiB || getDefaultLimitMiB();
    const addedMiB = Number(storageCode.amountMiB) || 0;
    const persisted = setUserMeta(handle, { storageLimitMiB: currentLimit + addedMiB }, { immediate: true });
    if (!persisted) {
        // The code is used up on disk, the new limit only in memory (retried): tell the admin
        console.error(`[STC-MOD] Storage code ${upperCode} was redeemed by "${handle}", but the new limit (${currentLimit + addedMiB} MiB, +${addedMiB} MiB) could not be saved yet; it stays pending and is retried. If SillyTavern stops before it is saved, raise the limit of "${handle}" by ${addedMiB} MiB by hand.`);
    }

    return {
        success: true,
        addedMiB,
        newLimitMiB: currentLimit + addedMiB,
        ...(persisted ? {} : { persisted: false }),
    };
}

/**
 * All storage codes, newest first.
 * @returns {object[]}
 * @throws {StoreUnavailableError}
 */
export function getAllStorageCodes() {
    return codesStore.read().sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Delete a storage code.
 * @param {string} code
 * @returns {boolean} false when there is no such code
 * @throws {StoreUnavailableError}
 */
export function deleteStorageCode(code) {
    const upperCode = String(code).toUpperCase();
    return codesStore.update((codes) => {
        const idx = codes.findIndex(c => c.code === upperCode);
        if (idx === -1) return false;
        codes.splice(idx, 1);
        return true;
    });
}
