/**
 * SillyTavernchat Module - Two-level flush scheduler
 *
 * Coalesces writes of an in-memory store into as few disk writes as possible while keeping real
 * changes durable quickly. Used by user-metadata.js; kept free of file I/O so the timing can be
 * unit-tested with a fake clock.
 *
 * Pending levels (the level only ever goes up until a flush runs):
 * - none:     nothing to write, no timer armed.
 * - activity: only low-value fields changed (e.g. `lastActiveAt` from heartbeats);
 *             flushed `activityDelayMs` after the first such change (fixed window, NOT extended
 *             by further pings), so activity-only writes happen at most once per window.
 * - real:     at least one real change is pending; flushed `realDelayMs` after the first real
 *             change of the batch. A real change while only activity is pending brings the
 *             flush forward (earliest due time wins), it is never delayed to the activity window.
 *
 * A single timer is used; arming never pushes an existing earlier deadline back. Deadlines use a
 * monotonic clock (performance.now) like the timers themselves, so a wall-clock step (NTP, VM
 * resume) can never make a real change wait for the activity window. Timers are
 * unref'd (they never keep the process alive). A flush writes everything pending (the store
 * is written as a whole), so a real flush also covers pending activity.
 * When the flush callback fails, the pending level is kept and a retry is armed
 * (`retryDelayMs`, default: `activityDelayMs`), unless an earlier flush is already due.
 */

import { performance } from 'node:perf_hooks';

export const FLUSH_LEVEL = Object.freeze({ NONE: 0, ACTIVITY: 1, REAL: 2 });

const LEVEL_NAMES = Object.freeze(['none', 'activity', 'real']);

/**
 * @typedef {Object} FlushSchedulerClock
 * @property {() => number} now Current time (ms)
 * @property {(fn: () => void, ms: number) => any} setTimer Arm a one-shot timer
 * @property {(timer: any) => void} clearTimer Cancel a timer returned by setTimer
 */

/** @type {FlushSchedulerClock} */
const SYSTEM_CLOCK = Object.freeze({
    // Monotonic: deadlines are only compared with each other and turned into setTimeout delays.
    // Resolved at call time so test timer mocks (node:test mock.timers) apply to the timers.
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer),
});

/**
 * @typedef {Object} FlushScheduler
 * @property {() => void} markActivity Record an activity-only change (flushed within activityDelayMs)
 * @property {() => void} markReal Record a real change (flushed within realDelayMs)
 * @property {() => boolean} flushNow Flush everything pending synchronously; true when nothing failed
 * @property {() => {pending: 'none'|'activity'|'real', dueAt: number|null}} getState Inspect the state
 *   (`dueAt` is on the scheduler clock: performance.now() milliseconds by default)
 */

/**
 * Create a flush scheduler.
 * @param {Object} options
 * @param {(info: {real: boolean}) => boolean|void} options.flush Writes the store. `real` is true when
 *   the batch contains a real change. Return false (or throw) on failure to keep the changes pending.
 * @param {number} options.realDelayMs Delay for real changes
 * @param {number} options.activityDelayMs Delay (window) for activity-only changes
 * @param {number} [options.retryDelayMs] Delay before retrying a failed flush (default: activityDelayMs)
 * @param {Partial<FlushSchedulerClock>} [options.clock] Injectable clock/timers (tests)
 * @param {(error: unknown) => void} [options.onError] Called when the flush callback throws
 * @returns {FlushScheduler}
 */
export function createFlushScheduler({ flush, realDelayMs, activityDelayMs, retryDelayMs, clock = {}, onError }) {
    if (typeof flush !== 'function') throw new TypeError('flush must be a function');
    const { now, setTimer, clearTimer } = { ...SYSTEM_CLOCK, ...clock };
    const retryMs = retryDelayMs ?? activityDelayMs;

    let level = FLUSH_LEVEL.NONE;
    let timer = null;
    /** @type {number|null} */
    let dueAt = null;

    function disarm() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        dueAt = null;
    }

    /**
     * Make sure a flush happens no later than `delayMs` from now. An already armed earlier timer is kept.
     * @param {number} delayMs
     */
    function armWithin(delayMs) {
        const at = now() + delayMs;
        if (timer !== null && dueAt !== null && dueAt <= at) return;
        disarm();
        dueAt = at;
        timer = setTimer(onTimer, delayMs);
        timer?.unref?.();
    }

    function onTimer() {
        timer = null;
        dueAt = null;
        runFlush();
    }

    /**
     * Flush the pending batch. On failure, the batch stays pending and a retry is armed.
     * @returns {boolean} true when the flush succeeded or nothing was pending
     */
    function runFlush() {
        const batch = level;
        if (batch === FLUSH_LEVEL.NONE) return true;
        // Reset first: a change made from inside the callback starts a new batch
        level = FLUSH_LEVEL.NONE;
        let ok = false;
        try {
            ok = flush({ real: batch === FLUSH_LEVEL.REAL }) !== false;
        } catch (error) {
            onError?.(error);
        }
        if (!ok) {
            level = Math.max(level, batch);
            armWithin(retryMs);
        }
        return ok;
    }

    return {
        markActivity() {
            if (level === FLUSH_LEVEL.REAL) {
                // The pending real flush (or its retry) also writes the activity
                if (timer === null) armWithin(realDelayMs);
                return;
            }
            level = FLUSH_LEVEL.ACTIVITY;
            armWithin(activityDelayMs);
        },
        markReal() {
            level = FLUSH_LEVEL.REAL;
            armWithin(realDelayMs);
        },
        flushNow() {
            disarm();
            return runFlush();
        },
        getState() {
            return { pending: /** @type {'none'|'activity'|'real'} */ (LEVEL_NAMES[level]), dueAt };
        },
    };
}
