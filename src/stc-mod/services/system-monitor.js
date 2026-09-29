/**
 * SillyTavernchat Module - System Monitor Service
 * Provides CPU, memory, disk usage monitoring.
 *
 * Notes:
 * - Disk usage reflects the filesystem that holds the data root, not the whole
 *   machine. The admin UI should label it accordingly.
 * - History is persisted atomically (temp file + rename, `.bak` copy) and capped, so a crash
 *   or concurrent write cannot corrupt or lose the whole history file.
 * - The history is read from disk once and then kept in memory. While the file cannot be read
 *   (StoreUnavailableError: remote storage / mount failure) new snapshots are only kept in memory
 *   and the file is never written, so a failed read can never replace the stored history with a
 *   shorter one; they are merged in once the file is readable again. An unparseable file (no
 *   usable `.bak`) is kept as `.corrupt-<ts>` and the history starts empty.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getStcDataDir, getDataRoot } from '../config.js';
import { readJsonFile, writeJsonFileAtomic } from './json-store.js';

const HISTORY_FILE = 'system-monitor-history.json';
const MAX_HISTORY_POINTS = 288; // 24h at 5min intervals

let lastCpuInfo = null;

/**
 * Sample raw CPU idle/total tick counts.
 * @returns {{ idle:number, total:number }}
 */
function sampleCpu() {
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
        for (const type in cpu.times) totalTick += cpu.times[type];
        totalIdle += cpu.times.idle;
    }
    return { idle: totalIdle / cpus.length, total: totalTick / cpus.length };
}

/**
 * CPU usage percentage based on the delta since the last sample.
 * Returns null when no baseline exists yet (so callers can omit the first point
 * instead of recording a misleading 0%).
 * @returns {number|null}
 */
function getCpuUsage() {
    const { idle, total } = sampleCpu();
    if (!lastCpuInfo) {
        lastCpuInfo = { idle, total };
        return null;
    }
    const idleDiff = idle - lastCpuInfo.idle;
    const totalDiff = total - lastCpuInfo.total;
    lastCpuInfo = { idle, total };
    return totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
}

/**
 * Establish the CPU baseline at startup so the first recorded snapshot has a
 * meaningful (non-zero-by-default) reading.
 */
function primeCpuBaseline() {
    if (!lastCpuInfo) lastCpuInfo = sampleCpu();
}

function getMemoryUsage() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
        total: Math.round(total / 1024 / 1024),
        used: Math.round(used / 1024 / 1024),
        free: Math.round(free / 1024 / 1024),
        percent: Math.round((used / total) * 100),
    };
}

function getDiskUsage() {
    try {
        const dataRoot = getDataRoot();
        const stats = fs.statfsSync(dataRoot);
        const total = stats.blocks * stats.bsize;
        const free = stats.bfree * stats.bsize;
        const used = total - free;
        return {
            total: Math.round(total / 1024 / 1024 / 1024 * 100) / 100,
            used: Math.round(used / 1024 / 1024 / 1024 * 100) / 100,
            free: Math.round(free / 1024 / 1024 / 1024 * 100) / 100,
            percent: Math.round((used / total) * 100),
            scope: 'dataRoot',
        };
    } catch {
        // `unknown`: the data root could not be measured (the zeros are not a reading)
        return { total: 0, used: 0, free: 0, percent: 0, scope: 'dataRoot', unknown: true };
    }
}

export function getSystemLoad() {
    const cpu = getCpuUsage();
    return {
        timestamp: Date.now(),
        cpu: cpu === null ? 0 : cpu,
        memory: getMemoryUsage(),
        disk: getDiskUsage(),
        uptime: Math.round(os.uptime()),
        loadAvg: os.loadavg(),
        platform: os.platform(),
        hostname: os.hostname(),
        nodeVersion: process.version,
    };
}

export function getHistoryPath() {
    return path.join(getStcDataDir(), HISTORY_FILE);
}

/** History loaded from disk (source of truth once set); null until the file was read. */
let historyCache = null;
/** Snapshots taken while the history file could not be read (merged on the next successful load). */
let pendingSnapshots = [];

/**
 * Keep at most MAX_HISTORY_POINTS points (oldest dropped).
 * @param {any[]} history
 */
function capHistory(history) {
    while (history.length > MAX_HISTORY_POINTS) history.shift();
}

/**
 * Load the history file into memory once (snapshots taken meanwhile are merged in).
 * @returns {any[]} The in-memory history
 * @throws {import('./json-store.js').StoreUnavailableError} The file cannot be read right now
 */
function ensureHistoryLoaded() {
    if (historyCache) return historyCache;
    const result = readJsonFile(getHistoryPath(), { validate: Array.isArray, backup: true, label: 'Monitor history' });
    const stored = result.status === 'ok' || result.status === 'recovered' ? result.data : [];
    const lastStored = stored.length ? Number(stored[stored.length - 1]?.timestamp) || 0 : 0;
    historyCache = stored.concat(pendingSnapshots.filter(point => point.timestamp > lastStored));
    pendingSnapshots = [];
    capHistory(historyCache);
    return historyCache;
}

/**
 * Stored history (read once, then served from memory).
 * @returns {any[]}
 * @throws {import('./json-store.js').StoreUnavailableError} The history has never been readable yet
 */
export function loadHistory() {
    return ensureHistoryLoaded().slice();
}

/**
 * Atomically persist history (temp file + rename) with a single backup copy.
 * A failed write keeps the history in memory (retried with the next snapshot).
 * @param {any[]} history
 */
function saveHistory(history) {
    try {
        writeJsonFileAtomic(getHistoryPath(), history, { backup: true, space: 0 });
    } catch (e) {
        console.error('[STC-MOD] Failed to save monitor history:', e?.detail || e?.message);
    }
}

export function recordSnapshot() {
    const snapshot = getSystemLoad();
    let history;
    try {
        history = ensureHistoryLoaded();
    } catch (e) {
        // Never write while the stored history is unknown: keep the point in memory
        pendingSnapshots.push(snapshot);
        capHistory(pendingSnapshots);
        console.error('[STC-MOD] Monitor history unavailable, snapshot kept in memory:', e?.detail || e?.message);
        return snapshot;
    }
    history.push(snapshot);
    capHistory(history);
    saveHistory(history);
    return snapshot;
}

let monitorInterval = null;

export function startMonitoring(intervalMs = 300000) {
    if (monitorInterval) return;
    // Prime the CPU baseline so the first interval snapshot is accurate.
    primeCpuBaseline();
    recordSnapshot();
    monitorInterval = setInterval(recordSnapshot, intervalMs);
    monitorInterval.unref();
    console.log('[STC-MOD] System monitoring started');
}

export function stopMonitoring() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
}
