/**
 * SillyTavernchat Module - Storage Quota Service
 * Manages user storage limits, check-in rewards, and expansion codes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getStcConfig, getStcDataDir, getDataRoot } from '../config.js';
import { getUserMeta, setUserMeta } from '../user-metadata.js';

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

/**
 * Calculate actual storage usage for a user in bytes
 * @param {string} handle
 * @returns {number} bytes used
 */
export function calculateUserStorage(handle) {
    const userDir = path.join(getDataRoot(), handle);
    if (!fs.existsSync(userDir)) return 0;
    return getDirSize(userDir);
}

function getDirSize(dirPath) {
    let total = 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                total += getDirSize(fullPath);
            } else if (entry.isFile()) {
                total += fs.statSync(fullPath).size;
            }
        }
    } catch { /* ignore */ }
    return total;
}

/**
 * Total size of the files under a directory, walked asynchronously (does not block the event loop
 * on slow / remote filesystems). Unreadable entries are skipped.
 * @param {string} dirPath
 * @returns {Promise<number>}
 */
async function getDirSizeAsync(dirPath) {
    let total = 0;
    let entries;
    try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        try {
            if (entry.isDirectory()) {
                total += await getDirSizeAsync(fullPath);
            } else if (entry.isFile()) {
                total += (await fs.promises.stat(fullPath)).size;
            }
        } catch { /* ignore */ }
    }
    return total;
}

/**
 * Storage used by a user in bytes, computed asynchronously (same rules as calculateUserStorage).
 * @param {string} handle
 * @returns {Promise<number|null>} bytes used (0 without a data directory), null if it cannot be determined
 */
export async function calculateUserStorageAsync(handle) {
    try {
        const userDir = path.join(getDataRoot(), handle);
        try {
            await fs.promises.access(userDir);
        } catch {
            return 0;
        }
        return await getDirSizeAsync(userDir);
    } catch {
        return null;
    }
}

/**
 * Get storage info for a user
 */
export function getUserStorageInfo(handle) {
    if (!isStorageLimitEnabled()) {
        return { enabled: false };
    }

    const meta = getUserMeta(handle) || {};
    const limitMiB = meta.storageLimitMiB || getDefaultLimitMiB();
    const usedBytes = calculateUserStorage(handle);
    const usedMiB = Math.round(usedBytes / 1024 / 1024 * 100) / 100;
    const remainingMiB = Math.max(0, Math.round((limitMiB - usedMiB) * 100) / 100);

    return {
        enabled: true,
        limitMiB,
        usedMiB,
        remainingMiB,
        percent: limitMiB > 0 ? Math.round((usedMiB / limitMiB) * 100) : 0,
        canWrite: usedMiB < limitMiB,
        lastCheckInDate: meta.storageLastCheckInDate || null,
        dailyCheckInMiB: getDailyCheckInMiB(),
    };
}

/**
 * Check if user can write (has available storage)
 */
export function canUserWrite(handle) {
    if (!isStorageLimitEnabled()) return true;
    const info = getUserStorageInfo(handle);
    return info.canWrite;
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

function loadStorageCodes() {
    const filePath = path.join(getStcDataDir(), STORAGE_CODES_FILE);
    if (!fs.existsSync(filePath)) return [];
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return [];
    }
}

function saveStorageCodes(codes) {
    fs.writeFileSync(path.join(getStcDataDir(), STORAGE_CODES_FILE), JSON.stringify(codes, null, 2), 'utf8');
}

export function generateStorageCodes(count, amountMiB, createdBy) {
    const codes = loadStorageCodes();
    const newCodes = [];
    for (let i = 0; i < count; i++) {
        const code = {
            code: crypto.randomBytes(6).toString('hex').toUpperCase(),
            amountMiB,
            createdBy,
            createdAt: Date.now(),
            used: false,
            usedBy: null,
            usedAt: null,
        };
        codes.push(code);
        newCodes.push(code);
    }
    saveStorageCodes(codes);
    return newCodes;
}

export function useStorageCode(code, handle) {
    const codes = loadStorageCodes();
    const idx = codes.findIndex(c => c.code === code.toUpperCase() && !c.used);
    if (idx === -1) return { success: false, reason: '激活码无效或已使用' };

    const storageCode = codes[idx];
    codes[idx] = { ...storageCode, used: true, usedBy: handle, usedAt: Date.now() };
    saveStorageCodes(codes);

    const meta = getUserMeta(handle) || {};
    const currentLimit = meta.storageLimitMiB || getDefaultLimitMiB();
    setUserMeta(handle, { storageLimitMiB: currentLimit + storageCode.amountMiB });

    return {
        success: true,
        addedMiB: storageCode.amountMiB,
        newLimitMiB: currentLimit + storageCode.amountMiB,
    };
}

export function getAllStorageCodes() {
    return loadStorageCodes().sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteStorageCode(code) {
    const codes = loadStorageCodes();
    const idx = codes.findIndex(c => c.code === code.toUpperCase());
    if (idx === -1) return false;
    codes.splice(idx, 1);
    saveStorageCodes(codes);
    return true;
}
