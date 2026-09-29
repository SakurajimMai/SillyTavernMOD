/**
 * SillyTavernchat Module - Data root watchdog loop
 *
 * Used by services/json-store.js startDataRootWatchdog(). In production the loop runs in a worker
 * thread (this file is the worker entry): a synchronous filesystem call of the main thread that hangs
 * on a dead FUSE mount (official handlers and the STC stores use sync I/O) then cannot stop it, and it
 * can end the process with SIGKILL, because process.exit() waits for threads that are stuck in a
 * hung stat and never returns.
 *
 * Every `intervalMs` the data root anchor is stat'ed asynchronously:
 * - the stat fails, or the device id differs from the one recorded at startup -> "lost": the main
 *   thread is told (it logs and exits with 1 so Docker restarts the container); if the process is
 *   still alive `graceMs` later (main thread blocked, exit hanging), the worker SIGKILLs it;
 * - the stat has not returned after `stallMs` (hung mount) -> the worker logs straight to fd 2 and
 *   SIGKILLs the process (exit code 137; Docker's unless-stopped policy restarts it);
 * - a loss the main thread observed itself (the per-access guard, see json-store.js
 *   checkDataRoot) is picked up at the next check and handled like a lost mount.
 * The stat itself runs synchronously in a small nested "prober" thread: an fs.promises.stat would
 * queue behind other work in the libuv threadpool (slow remote reads, usage counting), and that
 * waiting must not look like a hung mount.
 * Shared memory (BigInt64Array over a SharedArrayBuffer) carries "stat pending since" (so the main
 * thread can refuse store access without touching a hung mount) and the "lost" flag.
 * Times: pending-since values are epoch milliseconds from performance.timeOrigin + performance.now()
 * (comparable across threads, unaffected by Date.now() overrides); durations use performance.now().
 */
/* global Atomics, BigInt, BigInt64Array, SharedArrayBuffer */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

/** Shared slot: epoch ms since which the current stat is pending (0 = none). */
export const SHARED_PENDING_SINCE = 0;
/** Shared slot: epoch ms at which the data root was declared lost (0 = not lost). */
export const SHARED_LOST_AT = 1;
/** Number of BigInt64 slots of the shared buffer. */
export const SHARED_SLOTS = 2;

/**
 * Epoch milliseconds from the monotonic clock of this thread.
 * @returns {number}
 */
export function epochNow() {
    return performance.timeOrigin + performance.now();
}

/**
 * Short technical description of an error for logs.
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
    const e = /** @type {any} */ (error);
    return e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e);
}

/**
 * @typedef {Object} WatchdogLoop
 * @property {() => void} tick Start a stat (unless one is pending), check the stall and an external loss
 * @property {() => void} checkStall Check only the stall of a pending stat
 * @property {() => void} stop
 * @property {() => number} pendingSince Monotonic start of the pending stat (0 = none)
 */

/**
 * Watchdog state machine (no timers: the caller calls tick() every interval).
 * @param {Object} options
 * @param {string} options.anchor Path that is stat'ed
 * @param {number} options.dev Device id recorded at startup
 * @param {string|null} options.mountPoint Mount point (log text)
 * @param {number} options.stallMs A stat pending this long counts as a hung mount
 * @param {(p: string) => Promise<{dev: number}>} options.stat
 * @param {() => number} options.now Monotonic clock (ms)
 * @param {(reason: string) => void} options.onLost Stat failed / device changed / external loss
 * @param {(reason: string) => void} options.onHung Stat pending for stallMs
 * @param {() => string|null} [options.externalLoss] Reason of a loss observed elsewhere (checked every tick)
 * @param {(since: number) => void} [options.onPending] Monotonic start of a stat, 0 when it returned
 * @returns {WatchdogLoop}
 */
export function createWatchdogLoop({ anchor, dev, mountPoint, stallMs, stat, now, onLost, onHung, externalLoss, onPending }) {
    let pendingSince = 0;
    let done = false;

    const finish = (fn, reason) => {
        if (done) return;
        done = true;
        fn(reason);
    };

    const checkStall = () => {
        if (done || !pendingSince) return;
        const pendingMs = now() - pendingSince;
        if (pendingMs >= stallMs) {
            finish(onHung, `stat of ${anchor} has not returned for ${Math.round(pendingMs / 1000)} s (hung mount ${mountPoint})`);
        }
    };

    const tick = () => {
        if (done) return;
        const external = externalLoss?.();
        if (external) {
            finish(onLost, external);
            return;
        }
        if (pendingSince) {
            checkStall();
            return;
        }
        pendingSince = now();
        onPending?.(pendingSince);
        Promise.resolve()
            .then(() => stat(anchor))
            .then((result) => {
                pendingSince = 0;
                onPending?.(0);
                if (result.dev !== dev) {
                    finish(onLost, `data root ${anchor} changed device (${dev} -> ${result.dev}); the mount ${mountPoint} is gone`);
                }
            }, (error) => {
                pendingSince = 0;
                onPending?.(0);
                finish(onLost, `data root ${anchor} cannot be stat'ed (${describe(error)}); the mount ${mountPoint} is gone or broken`);
            });
    };

    return {
        tick,
        checkStall,
        stop() {
            done = true;
        },
        pendingSince: () => pendingSince,
    };
}

/**
 * @typedef {Object} WatchdogWorkerData
 * @property {string} anchor
 * @property {number} dev
 * @property {string|null} mountPoint
 * @property {number} intervalMs
 * @property {number} stallMs
 * @property {number} graceMs After a loss, SIGKILL when the process is still alive this much later
 * @property {boolean} kill SIGKILL allowed (false in tests with an injected exit)
 * @property {SharedArrayBuffer} shared
 */

/**
 * Stat function backed by a prober thread that calls fs.statSync (no libuv threadpool). Falls back
 * to fs.promises.stat when the prober cannot run.
 * @returns {(p: string) => Promise<{dev: number}>}
 */
function createProberStat() {
    /** @type {{resolve: (v: {dev: number}) => void, reject: (e: Error) => void}|null} */
    let pending = null;
    /** @type {Worker|null} */
    let prober = null;
    const fail = (error) => {
        prober = null;
        const waiting = pending;
        pending = null;
        waiting?.reject(error);
    };
    try {
        prober = new Worker(new URL(import.meta.url), {
            workerData: { stcDataRootProbe: true },
            resourceLimits: { maxOldGenerationSizeMb: 16 },
        });
        prober.on('message', (message) => {
            const waiting = pending;
            pending = null;
            if (!waiting) return;
            if (message?.error) {
                waiting.reject(Object.assign(new Error(String(message.error.message)), { code: message.error.code }));
            } else {
                waiting.resolve({ dev: message.dev });
            }
        });
        prober.on('error', fail);
        prober.on('exit', () => fail(new Error('data root prober thread exited')));
        prober.unref();
    } catch {
        prober = null;
    }
    return (p) => {
        if (!prober) return fs.promises.stat(p);
        return new Promise((resolve, reject) => {
            pending = { resolve, reject };
            prober?.postMessage(p);
        });
    };
}

/**
 * Worker thread entry.
 * @param {WatchdogWorkerData} data
 */
function runWorker(data) {
    const flags = new BigInt64Array(data.shared);
    const log = (line) => {
        // Synchronous write to the process's stderr: console output of a worker is forwarded by
        // the main thread, which may be blocked, and the process may be killed right after
        try {
            fs.writeSync(2, `${line}\n`);
        } catch {
            // Nothing else to do
        }
    };
    const kill = (why) => {
        if (!data.kill) return;
        log(`[STC-MOD] ${why}: killing the process (SIGKILL) so that Docker restarts it.`);
        process.kill(process.pid, 'SIGKILL');
    };

    let lostAt = 0;
    const loop = createWatchdogLoop({
        anchor: data.anchor,
        dev: data.dev,
        mountPoint: data.mountPoint,
        stallMs: data.stallMs,
        stat: createProberStat(),
        now: () => performance.now(),
        onPending: (since) => {
            Atomics.store(flags, SHARED_PENDING_SINCE, since ? BigInt(Math.round(epochNow())) : 0n);
        },
        externalLoss: () => (Atomics.load(flags, SHARED_LOST_AT) !== 0n ? 'data root loss observed by an STC store access' : null),
        onLost: (reason) => {
            lostAt = performance.now();
            if (Atomics.load(flags, SHARED_LOST_AT) === 0n) Atomics.store(flags, SHARED_LOST_AT, BigInt(Math.round(epochNow())));
            parentPort?.postMessage({ type: 'lost', reason });
        },
        onHung: (reason) => {
            Atomics.store(flags, SHARED_LOST_AT, BigInt(Math.round(epochNow())));
            log(`[STC-MOD] Data root lost: ${reason}. Exiting so that the container restarts and waits for the mount again (config.yaml stcDataRootWatchdog: false disables this).`);
            parentPort?.postMessage({ type: 'hung', reason });
            kill('Hung data root mount');
        },
    });

    const stepMs = Math.max(1, Math.min(1000, data.intervalMs));
    let sinceTick = 0;
    setInterval(() => {
        if (lostAt) {
            if (performance.now() - lostAt >= data.graceMs) {
                lostAt = 0;
                kill(`The process did not exit within ${Math.round(data.graceMs / 1000)} s after the data root was lost`);
            }
            return;
        }
        sinceTick += stepMs;
        if (sinceTick >= data.intervalMs) {
            sinceTick = 0;
            loop.tick();
        } else {
            loop.checkStall();
        }
    }, stepMs);
}

if (!isMainThread && workerData?.stcDataRootWatchdog) {
    runWorker(workerData.stcDataRootWatchdog);
} else if (!isMainThread && workerData?.stcDataRootProbe) {
    // Prober thread: one synchronous stat per message (blocks only this thread on a hung mount)
    parentPort?.on('message', (target) => {
        try {
            parentPort?.postMessage({ dev: fs.statSync(String(target)).dev });
        } catch (error) {
            const e = /** @type {any} */ (error);
            parentPort?.postMessage({ error: { code: e?.code, message: String(e?.message ?? e) } });
        }
    });
}
