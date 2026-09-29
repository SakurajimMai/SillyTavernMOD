/**
 * SillyTavernchat Module - JSON file stores that never mistake a storage failure for "no data"
 *
 * The data root may be a FUSE mount of remote object storage (JuiceFS on B2). When the mount
 * disappears, the same paths resolve to the EMPTY directory underneath (ENOENT everywhere); when
 * the FUSE daemon dies, paths fail with ENOTCONN / EIO. A store must then refuse to work instead
 * of starting empty and later overwriting the real data.
 *
 * Read classification (readJsonFile):
 * - `ok`         the file was parsed and validated;
 * - `missing`    ENOENT (and the data root guard still passes) and no usable `.bak`: the store does
 *                not exist yet (an unreadable `.bak` is kept as `.bak.corrupt-<ts>` first);
 * - `recovered`  the file is unparseable / invalid, or missing, but `<file>.bak` is valid: its data is
 *                returned, a copy of a broken file is kept as `<file>.corrupt-<ts>` and the next write
 *                does not copy the broken file over the good `.bak`;
 * - `corrupt`    unparseable / invalid and no usable `.bak`: the broken file (and a broken `.bak`)
 *                are kept as `.corrupt-<ts>` copies, the caller starts from its empty value;
 * - any other error (EIO, ENOTCONN, EACCES, EPERM, ETIMEDOUT, EISDIR, ENOTDIR, EBUSY, ...) throws
 *   StoreUnavailableError: there is no fallback value.
 * The data root guard is checked before and again after the read, so neither an ENOENT nor a
 * stale copy under a mount that vanished meanwhile is taken for the store.
 *
 * Data root guard: at startup the device id of the data root is recorded, and whether it lives on a
 * mounted filesystem other than `/` (production: the data root /mnt/jfs/fs/data sits inside the
 * FUSE mount /mnt/jfs/fs). While that is the case, every store read / write first checks that the
 * data root can still be stat'ed and has the same device id; otherwise StoreUnavailableError. A data
 * root that cannot be stat'ed at startup (other than ENOENT) is unusable until the next start.
 * The watchdog (a worker thread, see data-root-watchdog.js) checks the same every 15 s and exits
 * the process on loss (Docker restarts the container; its entrypoint waits for the mount again); a
 * hung mount is killed with SIGKILL. While it runs, a loss observed by a store access is sticky: a
 * mount that comes back with the same device id (Linux reuses it) is not trusted again.
 *
 * Writes (writeJsonFileAtomic) go to a temp file (same directory, original mode kept, fsync'ed)
 * that is renamed over the target, optionally after copying the current file to `.bak`. In
 * "expect missing" mode (the store was read as `missing`) the temp file is hard-linked to the
 * target instead, which fails with EEXIST when a file appeared meanwhile: StoreConflictError, the
 * caller reloads instead of overwriting.
 *
 * HTTP: StoreUnavailableError becomes 503 `{ error: '数据存储暂时不可用，请稍后重试', code: 'STORE_UNAVAILABLE' }`
 * for API requests and a short 503 text for pages (sendStoreUnavailable / storeErrorHandler).
 *
 * Migrating a simple read-modify-write store (e.g. storage-quota.js storage codes):
 *   const codesStore = createJsonStore({
 *       label: 'storage codes',
 *       file: () => path.join(getStcDataDir(), STORAGE_CODES_FILE),
 *       validate: Array.isArray,
 *       empty: () => [],
 *   });
 *   loadStorageCodes()  -> codesStore.read()
 *   load + change + save -> codesStore.update(codes => { ...change codes in place...; return result; })
 * The update callback may run more than once (conflict retry): keep other side effects outside.
 */
/* global Atomics, BigInt, BigInt64Array, SharedArrayBuffer */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import {
    SHARED_LOST_AT,
    SHARED_PENDING_SINCE,
    SHARED_SLOTS,
    createWatchdogLoop,
    epochNow,
} from './data-root-watchdog.js';

export const STORE_UNAVAILABLE_CODE = 'STORE_UNAVAILABLE';
export const STORE_UNAVAILABLE_MESSAGE = '数据存储暂时不可用，请稍后重试';

/** Watchdog check interval (ms). */
export const DATA_ROOT_WATCHDOG_INTERVAL_MS = 15_000;
/** A watchdog stat that has not returned after this long counts as a lost data root (hung FUSE mount). */
const WATCHDOG_STALL_MS = 4 * DATA_ROOT_WATCHDOG_INTERVAL_MS;
/** After a loss, the watchdog worker kills the process when it has not exited this much later. */
const WATCHDOG_EXIT_GRACE_MS = 10_000;
/**
 * While the watchdog's stat has been pending this long, store accesses are refused without a
 * synchronous stat of the data root (which would block the event loop on a hanging mount).
 */
const HUNG_HINT_MS = 5000;
/** Retries of an update after a StoreConflictError. */
const MAX_UPDATE_ATTEMPTS = 3;
/** Error codes of hard-link attempts on filesystems without hard links (fall back to an exclusive create). */
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES']);

/**
 * The store cannot be read or written right now (remote storage / mount failure, permissions...).
 * Never means "no data". HTTP 503 (see sendStoreUnavailable).
 */
export class StoreUnavailableError extends Error {
    /**
     * @param {string} detail Technical reason (logs only)
     * @param {{cause?: unknown, file?: string}} [options]
     */
    constructor(detail, { cause, file } = {}) {
        super(STORE_UNAVAILABLE_MESSAGE, cause === undefined ? undefined : { cause });
        this.name = 'StoreUnavailableError';
        this.code = STORE_UNAVAILABLE_CODE;
        this.status = 503;
        this.detail = String(detail || 'store unavailable');
        if (file) this.file = file;
    }
}

/**
 * An "expect missing" write found an existing file: reload it instead of overwriting it.
 */
export class StoreConflictError extends Error {
    /**
     * @param {string} file
     */
    constructor(file) {
        super(`${path.basename(file)} appeared while the store was treated as new`);
        this.name = 'StoreConflictError';
        this.code = 'STORE_CONFLICT';
        this.file = file;
    }
}

/**
 * @param {unknown} error
 * @returns {error is StoreUnavailableError}
 */
export function isStoreUnavailableError(error) {
    return error instanceof StoreUnavailableError
        || (!!error && typeof error === 'object' && /** @type {any} */ (error).code === STORE_UNAVAILABLE_CODE);
}

/**
 * Short technical description of an error for logs.
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
    if (error instanceof StoreUnavailableError) return error.detail;
    const e = /** @type {any} */ (error);
    return e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e);
}

/**
 * Wrap a filesystem error as StoreUnavailableError (store errors are passed through).
 * @param {unknown} error
 * @param {string} file
 * @param {string} action
 * @returns {Error}
 */
function toUnavailable(error, file, action) {
    if (isStoreUnavailableError(error) || error instanceof StoreConflictError) return /** @type {Error} */ (error);
    return new StoreUnavailableError(`${action} ${path.basename(file)} failed (${describeError(error)})`, { cause: error, file });
}

// ---------------------------------------------------------------------------
// Data root guard + watchdog
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DataRootGuardState
 * @property {string} root Data root
 * @property {string} anchor Path whose device id is checked (the data root, or its nearest existing ancestor at startup)
 * @property {number|null} dev Device id of the anchor at startup (null: could not be determined)
 * @property {boolean} mounted The anchor lives on a mounted filesystem other than `/` (guard active)
 * @property {string|null} mountPoint Nearest mount point at or above the anchor (informational)
 * @property {string|null} lostReason Set when the data root is unusable for good (sticky): it could not
 *   be stat'ed at startup, is not a mount although `requireMount` asks for one, the watchdog declared
 *   it lost, or a store access observed a loss while the watchdog runs
 */

/** @type {DataRootGuardState|null} */
let guardState = null;
/** @type {(p: string) => {dev: number}} */
let guardStat = (p) => fs.statSync(p);
let lastGuardFailureLog = 0;

/**
 * Data root the guard watches when it was not initialized explicitly. Same as config.js
 * getDataRoot() (not imported: config.js imports this module).
 * @returns {string}
 */
function defaultDataRoot() {
    return globalThis.DATA_ROOT || path.join(process.cwd(), 'data');
}

/**
 * Record the device id of the data root and whether it is on a mount (call once at startup).
 * A stat error other than ENOENT (e.g. ENOTCONN of a dead FUSE mount) makes the data root unusable
 * until the next start (lostReason): the STC stores answer 503 and the watchdog, when enabled, exits
 * so that Docker restarts the container. The detection compares device ids: a mount that disappears
 * and comes back between two checks keeps its device id and is not noticed by the device check alone
 * (Linux reuses the anonymous device id of the remounted filesystem).
 * @param {{root?: string, statSync?: (p: string) => {dev: number}, requireMount?: boolean}} [options]
 *   statSync: injectable (tests); requireMount (config.yaml `stcDataRootMustBeMount`): a data root
 *   that is not on its own mount is unusable
 * @returns {DataRootGuardState}
 */
export function initDataRootGuard({ root, statSync, requireMount = false } = {}) {
    guardStat = statSync ?? ((p) => fs.statSync(p));
    const resolvedRoot = path.resolve(root || defaultDataRoot());
    /** @type {DataRootGuardState} */
    const state = { root: resolvedRoot, anchor: resolvedRoot, dev: null, mounted: false, mountPoint: null, lostReason: null };

    // The data root may not exist yet on a fresh install: watch its nearest existing ancestor
    let anchor = resolvedRoot;
    let anchorDev = null;
    let startupError = null;
    for (;;) {
        try {
            anchorDev = guardStat(anchor).dev;
            break;
        } catch (error) {
            const parent = path.dirname(anchor);
            if (/** @type {any} */ (error)?.code !== 'ENOENT' || parent === anchor) {
                startupError = error;
                break;
            }
            anchor = parent;
        }
    }
    state.anchor = anchor;
    if (anchorDev === null) {
        state.lostReason = `data root ${anchor} cannot be stat'ed at startup (${describeError(startupError)}); the mount is missing or broken`;
        console.error(`[STC-MOD] Data root guard: ${state.lostReason}. The STC stores stay unavailable (503) until a restart finds the data root usable.`);
        guardState = state;
        return state;
    }
    state.dev = anchorDev;

    // Nearest mount point: walk up while the parent is on the same device
    let dir = anchor;
    for (;;) {
        const parent = path.dirname(dir);
        if (parent === dir) {
            state.mountPoint = dir;
            break;
        }
        let parentDev;
        try {
            parentDev = guardStat(parent).dev;
        } catch {
            state.mountPoint = dir;
            break;
        }
        if (parentDev !== anchorDev) {
            state.mountPoint = dir;
            break;
        }
        dir = parent;
    }
    try {
        state.mounted = guardStat(path.parse(anchor).root).dev !== anchorDev;
    } catch {
        state.mounted = state.mountPoint !== path.parse(anchor).root;
    }
    guardState = state;
    if (state.mounted) {
        console.log(`[STC-MOD] Data root guard: ${resolvedRoot} is on the mount ${state.mountPoint} (dev ${anchorDev}); STC stores stop if it disappears`);
    } else if (requireMount) {
        state.lostReason = `data root ${resolvedRoot} is not on a separate mount (config.yaml stcDataRootMustBeMount: true); the mount is missing`;
        console.error(`[STC-MOD] Data root guard: ${state.lostReason}. The STC stores stay unavailable (503) until a restart finds the mount.`);
    }
    return state;
}

/**
 * Current guard state (initialized lazily).
 * @returns {DataRootGuardState}
 */
export function getDataRootGuardState() {
    return guardState ?? initDataRootGuard();
}

/**
 * A failure observed by a store access: sticky while the watchdog runs (the next watchdog check
 * exits), so no change made while the data root looked empty can be flushed after a short blip.
 * @param {DataRootGuardState} state
 * @param {string} reason
 * @returns {{ok: false, reason: string}}
 */
function observedFailure(state, reason) {
    watchdog?.markLost(reason);
    return { ok: false, reason: state.lostReason || reason };
}

/**
 * Check the data root.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkDataRoot() {
    const state = getDataRootGuardState();
    if (state.lostReason) return { ok: false, reason: state.lostReason };
    if (!state.mounted || state.dev === null) return { ok: true };
    if (sharedFlags) {
        // The watchdog's stat has been pending for a while: do not risk a synchronous stat that
        // blocks the event loop on a hanging mount (not sticky: a slow stat may still return)
        const since = Number(Atomics.load(sharedFlags, SHARED_PENDING_SINCE));
        const pendingMs = since > 0 ? epochNow() - since : 0;
        if (pendingMs >= HUNG_HINT_MS) {
            return { ok: false, reason: `data root ${state.anchor} has not answered the watchdog's stat for ${Math.round(pendingMs / 1000)} s (the mount ${state.mountPoint} hangs?)` };
        }
    }
    let stat;
    try {
        stat = guardStat(state.anchor);
    } catch (error) {
        return observedFailure(state, `data root ${state.anchor} cannot be stat'ed (${describeError(error)}); the mount ${state.mountPoint} is gone or broken`);
    }
    if (stat.dev !== state.dev) {
        return observedFailure(state, `data root ${state.anchor} changed device (${state.dev} -> ${stat.dev}); the mount ${state.mountPoint} is gone`);
    }
    return { ok: true };
}

/**
 * Throw StoreUnavailableError when the data root was a mount at startup and is gone now.
 */
export function assertDataRootAvailable() {
    const check = checkDataRoot();
    if (check.ok) return;
    const now = Date.now();
    if (now - lastGuardFailureLog >= 10_000 || now < lastGuardFailureLog) {
        lastGuardFailureLog = now;
        console.error(`[STC-MOD] STC data store refused: ${check.reason}`);
    }
    throw new StoreUnavailableError(check.reason);
}

/**
 * @typedef {Object} DataRootWatchdog
 * @property {() => void} stop
 * @property {(reason: string) => void} markLost Declare the data root lost (sticky); the next check exits
 * @property {NodeJS.Timeout|null} timer Interval timer (in-process variant)
 * @property {import('node:worker_threads').Worker|null} worker Worker thread (default variant)
 */

/** @type {DataRootWatchdog|null} */
let watchdog = null;
/**
 * Memory shared with the watchdog worker (see data-root-watchdog.js SHARED_*), null without a worker.
 * @type {BigInt64Array|null}
 */
let sharedFlags = null;

/**
 * Start the data root watchdog (only when the data root was a mount at startup): every 15 s the
 * data root is stat'ed asynchronously; when it is gone or has another device id, an error is logged,
 * all STC stores are blocked for good and the process exits with 1. A stat that hangs for 60 s (hung
 * FUSE mount) is logged and the process is killed with SIGKILL (process.exit would wait for the
 * thread stuck in the stat forever). While the watchdog runs, a loss observed by any store access is
 * sticky and makes the next check exit. A data root that was unusable at startup exits right away.
 * By default the checks run in a worker thread (services/data-root-watchdog.js), so a main thread
 * blocked in a synchronous call on a hung mount cannot stop them; after a loss the worker also kills
 * the process when it has not exited within `graceMs`.
 * @param {{enabled?: boolean, intervalMs?: number, stallMs?: number, graceMs?: number, exit?: (code: number) => void, statAsync?: (p: string) => Promise<{dev: number}>, useWorker?: boolean}} [options]
 *   stallMs: a stat pending this long counts as a hung mount (default 60 s); exit / statAsync:
 *   injectable (tests; an injected statAsync runs the checks on the main thread, an injected exit
 *   disables the worker's SIGKILL); useWorker: false runs the checks on the main thread
 * @returns {DataRootWatchdog|null} null when not started
 */
export function startDataRootWatchdog({
    enabled = true,
    intervalMs = DATA_ROOT_WATCHDOG_INTERVAL_MS,
    stallMs = WATCHDOG_STALL_MS,
    graceMs = WATCHDOG_EXIT_GRACE_MS,
    exit,
    statAsync,
    useWorker = true,
} = {}) {
    if (watchdog) return watchdog;
    const state = getDataRootGuardState();
    const doExit = exit ?? ((code) => process.exit(code));
    if (!enabled) {
        if (state.lostReason) {
            console.error('[STC-MOD] stcDataRootWatchdog is off: the STC stores stay unavailable until SillyTavern is restarted with a usable data root');
        } else if (state.mounted) {
            console.warn('[STC-MOD] stcDataRootWatchdog is off: a lost data root mount only blocks the STC stores (no automatic restart)');
        }
        return null;
    }
    if (state.lostReason) {
        // Unusable at startup (e.g. a dead FUSE mount): restart instead of answering 503 forever
        console.error(`[STC-MOD] Data root lost: ${state.lostReason}. Exiting so that the container restarts and waits for the mount again (config.yaml stcDataRootWatchdog: false disables this).`);
        doExit(1);
        return null;
    }
    if (!state.mounted || state.dev === null) return null;

    let stopped = false;
    /** @type {import('./data-root-watchdog.js').WatchdogLoop|null} */
    let loop = null;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    /** @type {Worker|null} */
    let worker = null;

    const lose = (reason) => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        loop?.stop();
        if (sharedFlags && Atomics.load(sharedFlags, SHARED_LOST_AT) === 0n) {
            Atomics.store(sharedFlags, SHARED_LOST_AT, BigInt(Math.round(epochNow())));
        }
        if (state.lostReason) {
            console.error(`[STC-MOD] Data root lost (${state.lostReason}): exiting now.`);
        } else {
            state.lostReason = reason;
            console.error(`[STC-MOD] Data root lost: ${reason}. Exiting so that the container restarts and waits for the mount again (config.yaml stcDataRootWatchdog: false disables this).`);
        }
        doExit(1);
    };

    const markLost = (reason) => {
        if (stopped || state.lostReason) return;
        state.lostReason = reason;
        if (sharedFlags) Atomics.store(sharedFlags, SHARED_LOST_AT, BigInt(Math.round(epochNow())));
        console.error(`[STC-MOD] Data root lost: ${reason}. Exiting at the next watchdog check (within ${Math.round(intervalMs / 1000)} s) so that the container restarts and waits for the mount again (config.yaml stcDataRootWatchdog: false disables this); the STC stores stay blocked until then.`);
    };

    const startInProcess = () => {
        loop = createWatchdogLoop({
            anchor: state.anchor,
            dev: /** @type {number} */ (state.dev),
            mountPoint: state.mountPoint,
            stallMs,
            stat: statAsync ?? ((p) => fs.promises.stat(p)),
            now: () => performance.now(),
            onLost: lose,
            onHung: lose,
            externalLoss: () => state.lostReason,
        });
        timer = setInterval(() => loop?.tick(), intervalMs);
        timer.unref?.();
        if (watchdog) watchdog.timer = timer;
    };

    if (statAsync || !useWorker) {
        startInProcess();
    } else {
        const shared = new SharedArrayBuffer(SHARED_SLOTS * BigInt64Array.BYTES_PER_ELEMENT);
        try {
            worker = new Worker(new URL('./data-root-watchdog.js', import.meta.url), {
                workerData: {
                    stcDataRootWatchdog: {
                        anchor: state.anchor,
                        dev: state.dev,
                        mountPoint: state.mountPoint,
                        intervalMs,
                        stallMs,
                        graceMs,
                        kill: !exit,
                        shared,
                    },
                },
                resourceLimits: { maxOldGenerationSizeMb: 32 },
            });
            sharedFlags = new BigInt64Array(shared);
            worker.on('message', (message) => {
                if (message?.type === 'lost' || message?.type === 'hung') lose(String(message.reason));
            });
            worker.on('error', (error) => {
                console.error('[STC-MOD] Data root watchdog worker failed; checking on the main thread instead:', describeError(error));
                sharedFlags = null;
                worker = null;
                if (watchdog) watchdog.worker = null;
                if (!stopped) startInProcess();
            });
            worker.unref();
        } catch (error) {
            console.error('[STC-MOD] Data root watchdog worker could not be started; checking on the main thread instead:', describeError(error));
            worker = null;
            sharedFlags = null;
            startInProcess();
        }
    }

    watchdog = {
        timer,
        worker,
        markLost,
        stop() {
            stopped = true;
            if (timer) clearInterval(timer);
            loop?.stop();
            if (worker) {
                worker.removeAllListeners('error');
                worker.on('error', () => {});
                worker.terminate().catch(() => {});
            }
            sharedFlags = null;
            watchdog = null;
        },
    };
    console.log(`[STC-MOD] Data root watchdog started (every ${Math.round(intervalMs / 1000)} s${worker ? ', worker thread' : ''})`);
    return watchdog;
}

/**
 * Stop the watchdog (tests).
 */
export function stopDataRootWatchdog() {
    watchdog?.stop();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Main files known to be unreadable (from a `recovered` / `corrupt` read): the next write must not
 * copy them over `.bak`. Map<file, stat stamp of the broken file>.
 * @type {Map<string, string>}
 */
const knownBadFiles = new Map();
/**
 * Broken files already copied aside in this process (stamp -> copy), to avoid a copy per read.
 * @type {Map<string, string>}
 */
const preservedStamps = new Map();

/**
 * @param {typeof fs} fsi
 * @param {string} file
 * @returns {string|null}
 */
function statStamp(fsi, file) {
    try {
        const stat = fsi.statSync(file);
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
        return null;
    }
}

/**
 * @typedef {{kind: 'ok', data: any} | {kind: 'missing'} | {kind: 'corrupt', reason: string}} FileReadOutcome
 */

/**
 * Read and parse one file.
 * @param {typeof fs} fsi
 * @param {string} file
 * @param {((data: any) => boolean|void)|undefined} validate
 * @returns {FileReadOutcome}
 * @throws {StoreUnavailableError} On any read error other than ENOENT
 */
function readOne(fsi, file, validate) {
    let raw;
    try {
        raw = fsi.readFileSync(file, 'utf8');
    } catch (error) {
        if (/** @type {any} */ (error)?.code === 'ENOENT') return { kind: 'missing' };
        throw toUnavailable(error, file, 'Reading');
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (error) {
        return { kind: 'corrupt', reason: `invalid JSON (${describeError(error)})` };
    }
    if (validate) {
        try {
            if (validate(data) === false) return { kind: 'corrupt', reason: 'unexpected content' };
        } catch (error) {
            return { kind: 'corrupt', reason: `unexpected content (${describeError(error)})` };
        }
    }
    return { kind: 'ok', data };
}

/**
 * Keep a copy of an unreadable file as `<file>.corrupt-<timestamp>` (once per file version).
 * @param {typeof fs} fsi
 * @param {string} file
 * @returns {string|null} The copy (or the earlier copy of the same version); null when it could not be made
 */
function preserveUnreadable(fsi, file) {
    const stamp = statStamp(fsi, file);
    const key = `${file}|${stamp}`;
    if (stamp && preservedStamps.has(key)) return preservedStamps.get(key) ?? null;
    const base = `${file}.corrupt-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
        const target = i === 0 ? base : `${base}-${i}`;
        try {
            fsi.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
            if (stamp) preservedStamps.set(key, target);
            console.error(`[STC-MOD] Kept the unreadable ${path.basename(file)} as ${target}`);
            return target;
        } catch (error) {
            if (/** @type {any} */ (error)?.code === 'EEXIST') continue;
            console.error(`[STC-MOD] Could not keep a copy of the unreadable ${path.basename(file)}:`, describeError(error));
            return null;
        }
    }
    return null;
}

/**
 * @typedef {Object} JsonReadResult
 * @property {'ok'|'missing'|'recovered'|'corrupt'} status
 * @property {any} data Parsed data (`ok` / `recovered`), undefined otherwise
 * @property {string} [reason] Why the main file is unusable (`recovered` / `corrupt`)
 * @property {boolean} [mainMissing] `recovered` because the main file does not exist (the data comes
 *   from `.bak`): the first write must create the file without replacing one that appeared meanwhile
 */

/**
 * @typedef {Object} JsonReadOptions
 * @property {(data: any) => boolean|void} [validate] Return false (or throw) when the parsed value is not acceptable
 * @property {boolean} [backup] Try `<file>.bak` when the main file is unusable or missing (default true)
 * @property {boolean} [guard] Check the data root guard first (default true)
 * @property {string} [label] Store name for logs
 * @property {typeof fs} [fs] Injectable fs (tests)
 */

/** Repeated log lines about the same broken / recovered file: at most once per this interval (ms). */
const READ_LOG_INTERVAL_MS = 10 * 60 * 1000;
/** @type {Map<string, number>} */
const readLogTimes = new Map();

/**
 * Log once per `key` and READ_LOG_INTERVAL_MS (a store read on every request must not flood the log).
 * @param {string} key
 * @param {() => void} log
 */
function logThrottled(key, log) {
    const now = Date.now();
    const last = readLogTimes.get(key);
    if (last !== undefined && now - last < READ_LOG_INTERVAL_MS && now >= last) return;
    if (readLogTimes.size > 1000) readLogTimes.clear();
    readLogTimes.set(key, now);
    log();
}

/**
 * Read a JSON store file with error classification (see the module comment).
 * A missing main file with a valid `<file>.bak` is `recovered` (with `mainMissing`) instead of
 * `missing`, so a lost or removed main file never makes the store start empty (and the next writes
 * never replace the last good copy); a missing main file with an unreadable `.bak` keeps a copy of
 * that `.bak` as `.corrupt-<ts>` before the store starts empty.
 * @param {string} file
 * @param {JsonReadOptions} [options]
 * @returns {JsonReadResult}
 * @throws {StoreUnavailableError}
 */
export function readJsonFile(file, { validate, backup = true, guard = true, label, fs: fsi = fs } = {}) {
    if (guard) assertDataRootAvailable();
    const name = label || path.basename(file);
    const bakFile = `${file}.bak`;
    const main = readOne(fsi, file, validate);
    // Whatever was read (or found missing) may come from the filesystem under a mount that vanished meanwhile
    if (guard) assertDataRootAvailable();
    if (main.kind === 'ok') return { status: 'ok', data: main.data };

    if (main.kind === 'missing') {
        if (!backup) return { status: 'missing', data: undefined };
        const bak = readOne(fsi, bakFile, validate);
        if (guard) assertDataRootAvailable();
        if (bak.kind === 'ok') {
            logThrottled(`missing|${file}|${statStamp(fsi, bakFile)}`, () => {
                console.error(`[STC-MOD] ${name}: ${path.basename(file)} is missing but ${path.basename(bakFile)} is valid: using the backup (the next write recreates the file)`);
            });
            return { status: 'recovered', data: bak.data, reason: 'main file missing', mainMissing: true };
        }
        if (bak.kind === 'corrupt') {
            // Later writes would replace it with the new (nearly empty) store: keep a copy first
            logThrottled(`missing-corrupt|${file}|${statStamp(fsi, bakFile)}`, () => {
                console.error(`[STC-MOD] ${name}: ${path.basename(file)} is missing and ${path.basename(bakFile)} is unreadable (${bak.reason}); starting empty`);
            });
            preserveUnreadable(fsi, bakFile);
        }
        return { status: 'missing', data: undefined };
    }

    /** @type {FileReadOutcome} */
    const bak = backup ? readOne(fsi, bakFile, validate) : { kind: 'missing' };
    if (guard) assertDataRootAvailable();
    const stamp = statStamp(fsi, file);
    logThrottled(`corrupt|${file}|${stamp}`, () => {
        console.error(`[STC-MOD] ${name}: ${path.basename(file)} is unreadable (${main.reason})`);
    });
    if (bak.kind === 'ok') {
        preserveUnreadable(fsi, file);
        knownBadFiles.set(file, stamp ?? '');
        logThrottled(`recovered|${file}|${stamp}`, () => {
            console.warn(`[STC-MOD] ${name}: recovered from ${path.basename(bakFile)}`);
        });
        return { status: 'recovered', data: bak.data, reason: main.reason };
    }

    // No usable backup: the caller starts empty, so the unreadable bytes must be kept first
    if (!preserveUnreadable(fsi, file)) {
        throw new StoreUnavailableError(`${path.basename(file)} is unreadable and could not be copied aside; refusing to replace it`, { file });
    }
    if (bak.kind === 'corrupt') preserveUnreadable(fsi, bakFile);
    knownBadFiles.set(file, stamp ?? '');
    return { status: 'corrupt', data: undefined, reason: main.reason };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} JsonWriteOptions
 * @property {boolean} [backup] Copy the current file to `<file>.bak` first (skipped while the current file is known to be unreadable)
 * @property {boolean} [expectMissing] The store was read as `missing`: fail with StoreConflictError instead of replacing a file that appeared meanwhile
 * @property {number|string} [space] JSON indentation (default 2)
 * @property {number} [mode] Mode of a new file (default 0o666 minus umask); an existing file keeps its mode
 * @property {boolean} [guard] Check the data root guard first (default true)
 * @property {typeof fs} [fs] Injectable fs (tests)
 */

/**
 * Atomically write a JSON value (or a prepared string) to a store file.
 * @param {string} file
 * @param {any} value Value to serialize (a string is written as-is)
 * @param {JsonWriteOptions} [options]
 * @throws {StoreUnavailableError|StoreConflictError}
 */
export function writeJsonFileAtomic(file, value, { backup = false, expectMissing = false, space = 2, mode, guard = true, fs: fsi = fs } = {}) {
    if (guard) assertDataRootAvailable();
    const content = typeof value === 'string' ? value : JSON.stringify(value, null, space);

    let targetStat = null;
    try {
        targetStat = fsi.statSync(file);
    } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'ENOENT') throw toUnavailable(error, file, 'Checking');
    }
    if (targetStat && !targetStat.isFile()) {
        throw new StoreUnavailableError(`${path.basename(file)} is not a regular file`, { file });
    }
    if (expectMissing && targetStat) throw new StoreConflictError(file);

    const fileMode = targetStat ? targetStat.mode & 0o777 : (mode ?? 0o666);
    const tmpPath = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let tmpCreated = false;
    try {
        const fd = fsi.openSync(tmpPath, 'wx', fileMode);
        tmpCreated = true;
        try {
            if (targetStat) {
                try {
                    // Keep the original permissions (the umask may have narrowed them)
                    fsi.fchmodSync(fd, fileMode);
                } catch {
                    // Not supported on this filesystem
                }
            }
            fsi.writeFileSync(fd, content, 'utf8');
            fsi.fsyncSync(fd);
        } finally {
            fsi.closeSync(fd);
        }

        if (expectMissing) {
            let linked = false;
            try {
                fsi.linkSync(tmpPath, file);
                linked = true;
            } catch (error) {
                const code = /** @type {any} */ (error)?.code;
                if (code === 'EEXIST') throw new StoreConflictError(file);
                if (!LINK_UNSUPPORTED_CODES.has(code)) throw error;
            }
            if (!linked) {
                // No hard links on this filesystem: exclusive create (not atomic, but never replaces a file)
                try {
                    fsi.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: fileMode });
                } catch (error) {
                    if (/** @type {any} */ (error)?.code === 'EEXIST') throw new StoreConflictError(file);
                    throw error;
                }
            }
            // The target exists now: a failing temp cleanup must not report the write as failed
            tmpCreated = false;
            try {
                fsi.rmSync(tmpPath, { force: true });
            } catch (error) {
                console.warn(`[STC-MOD] Could not remove the temp file ${path.basename(tmpPath)}:`, describeError(error));
            }
        } else {
            if (backup && targetStat && !knownBadFiles.has(file)) {
                try {
                    fsi.copyFileSync(file, `${file}.bak`);
                } catch (error) {
                    console.error(`[STC-MOD] Could not refresh ${path.basename(file)}.bak:`, describeError(error));
                }
            }
            fsi.renameSync(tmpPath, file);
            tmpCreated = false;
        }
        knownBadFiles.delete(file);
    } catch (error) {
        if (tmpCreated) {
            try {
                fsi.rmSync(tmpPath, { force: true });
            } catch {
                // Ignore cleanup errors
            }
        }
        throw toUnavailable(error, file, 'Writing');
    }
}

// ---------------------------------------------------------------------------
// Read-modify-write stores
// ---------------------------------------------------------------------------

/**
 * @template T
 * @typedef {Object} JsonStore
 * @property {() => T} read Current data (the empty value when missing / corrupt)
 * @property {() => {data: T, status: JsonReadResult['status']}} load Current data with its read status
 * @property {<R>(mutator: (data: T) => R) => R} update Read, let `mutator` change the data in place, write
 *   it when it changed (expect-missing aware; retried on conflict, so `mutator` may run more than once)
 * @property {(data: T) => void} write Replace the whole content (no conflict detection)
 * @property {() => string} path Store file path
 */

/**
 * Create a small JSON file store (read-modify-write, no cache).
 * @template T
 * @param {Object} options
 * @param {string} options.label Store name for logs
 * @param {() => string} options.file Store file path (resolved on every access)
 * @param {(data: any) => boolean|void} [options.validate]
 * @param {() => T} options.empty Value of a missing / corrupt store
 * @param {boolean} [options.backup] Keep `.bak` copies (default true)
 * @param {number|string} [options.space] JSON indentation (default 2)
 * @returns {JsonStore<T>}
 */
export function createJsonStore({ label, file, validate, empty, backup = true, space = 2 }) {
    const loadFull = () => {
        const result = readJsonFile(file(), { validate, backup, label });
        const usable = result.status === 'ok' || result.status === 'recovered';
        return { data: usable ? result.data : empty(), status: result.status, mainMissing: result.mainMissing === true };
    };
    return {
        path: file,
        read: () => loadFull().data,
        load: () => {
            const { data, status } = loadFull();
            return { data, status };
        },
        update(mutator) {
            for (let attempt = 1; ; attempt++) {
                const { data, status, mainMissing } = loadFull();
                const before = JSON.stringify(data);
                const value = mutator(data);
                if (JSON.stringify(data) === before) return value;
                try {
                    writeJsonFileAtomic(file(), data, { backup, expectMissing: status === 'missing' || mainMissing, space });
                    return value;
                } catch (error) {
                    if (!(error instanceof StoreConflictError)) throw error;
                    if (attempt >= MAX_UPDATE_ATTEMPTS) {
                        throw new StoreUnavailableError(`${label}: the file kept appearing while it was being created`, { cause: error, file: file() });
                    }
                    console.warn(`[STC-MOD] ${label}: ${error.message}; reloading it`);
                }
            }
        },
        write(data) {
            writeJsonFileAtomic(file(), data, { backup, space });
        },
    };
}

/**
 * Validator: a plain JSON object (not null, not an array).
 * @param {any} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Whether the request expects a JSON answer (API calls) rather than a page.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function wantsJson(req) {
    const url = String(req?.originalUrl ?? req?.url ?? '');
    if (/^\/+api\//i.test(url)) return true;
    if (req?.xhr) return true;
    const accept = String(req?.headers?.accept ?? '');
    return accept.includes('application/json') && !accept.includes('text/html');
}

/**
 * Answer 503 STORE_UNAVAILABLE (JSON for API requests, a short text for pages).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {import('express').Response|undefined}
 */
export function sendStoreUnavailable(req, res) {
    if (res.headersSent) return undefined;
    res.set('Retry-After', '30');
    res.set('Cache-Control', 'no-store');
    if (wantsJson(req)) {
        return res.status(503).json({ error: STORE_UNAVAILABLE_MESSAGE, code: STORE_UNAVAILABLE_CODE });
    }
    return res.status(503).type('text/plain; charset=utf-8').send(`503 ${STORE_UNAVAILABLE_MESSAGE}`);
}

let lastHttpLog = 0;

/**
 * Log a store failure of a request (at most every 10 s).
 * @param {import('express').Request} req
 * @param {unknown} error
 */
function logRequestFailure(req, error) {
    const now = Date.now();
    if (now - lastHttpLog < 10_000 && now >= lastHttpLog) return;
    lastHttpLog = now;
    console.error(`[STC-MOD] ${req?.method ?? ''} ${req?.path ?? ''}: answered 503, ${describeError(error)}`);
}

/**
 * For try/catch blocks of routes: answer 503 when `error` is a StoreUnavailableError.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {unknown} error
 * @returns {boolean} true when the response was sent
 */
export function respondStoreError(req, res, error) {
    if (!isStoreUnavailableError(error)) return false;
    logRequestFailure(req, error);
    sendStoreUnavailable(req, res);
    return true;
}

/**
 * Express error handler (register after all routes): StoreUnavailableError -> 503.
 * @type {import('express').ErrorRequestHandler}
 */
export function storeErrorHandler(err, req, res, next) {
    if (!isStoreUnavailableError(err) || res.headersSent) return next(err);
    logRequestFailure(req, err);
    return sendStoreUnavailable(req, res);
}
