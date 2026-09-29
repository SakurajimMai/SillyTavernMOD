/**
 * SillyTavernchat Module - Scheduled Tasks (Admin)
 * Backup cleanups refuse to run while the data root mount is lost (503 STORE_UNAVAILABLE for the
 * admin route; the scheduled run is retried by the next check).
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAdminMiddleware, getAllUserHandles } from '../../../users.js';
import { getDataRoot, getStcConfig, setStcConfig } from '../../config.js';
import { createLimiter, getUsersUsage, recordUserFree } from '../../services/storage-quota.js';
import { assertDataRootAvailable, respondStoreError } from '../../services/json-store.js';

/** Users whose backups are cleaned at once. */
const BACKUP_CLEAN_CONCURRENCY = 4;

/**
 * Delete the files in a user's backups directory (asynchronous; a missing directory counts as empty).
 * @param {string} handle
 * @returns {Promise<{cleaned: number, freedBytes: number}>}
 */
async function cleanUserBackups(handle) {
    const backupsDir = path.join(getDataRoot(), handle, 'backups');
    let files;
    try {
        files = await fs.promises.readdir(backupsDir, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return { cleaned: 0, freedBytes: 0 };
        throw error;
    }
    let cleaned = 0;
    let freedBytes = 0;
    for (const entry of files) {
        if (!entry.isFile()) continue;
        const fp = path.join(backupsDir, entry.name);
        try {
            const stat = await fs.promises.stat(fp);
            await fs.promises.unlink(fp);
            freedBytes += stat.size;
            cleaned++;
        } catch {
            // Skip files that cannot be deleted
        }
    }
    if (cleaned > 0) recordUserFree(handle);
    return { cleaned, freedBytes };
}

/**
 * Clean the backups of several users with bounded concurrency.
 * @param {string[]} handles
 * @returns {Promise<{cleaned: number, freedBytes: number, failed: string[]}>}
 */
async function cleanBackupsOf(handles) {
    // The paths would resolve to the empty directory under a lost mount ("0 files cleaned")
    assertDataRootAvailable();
    const limit = createLimiter(BACKUP_CLEAN_CONCURRENCY);
    const totals = { cleaned: 0, freedBytes: 0, failed: /** @type {string[]} */ ([]) };
    await Promise.all(handles.map(handle => limit(async () => {
        try {
            const { cleaned, freedBytes } = await cleanUserBackups(handle);
            totals.cleaned += cleaned;
            totals.freedBytes += freedBytes;
        } catch (error) {
            totals.failed.push(handle);
            console.warn(`[STC-MOD] Backup cleanup of "${handle}" failed:`, error?.code || error?.message || error);
        }
    })));
    return totals;
}

// Simple in-process cron: check every minute if scheduled task should run
let cleanupInterval = null;

function startScheduledCleanup() {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(async () => {
        if (!getStcConfig('scheduledTasks.cleanBackups.enabled', false)) return;
        const lastRun = getStcConfig('scheduledTasks.cleanBackups.lastRun', 0);
        const intervalHours = getStcConfig('scheduledTasks.cleanBackups.intervalHours', 24);
        const now = Date.now();
        if (now - lastRun < intervalHours * 3600 * 1000) return;
        try {
            const handles = await getAllUserHandles();
            const { cleaned } = await cleanBackupsOf(handles);
            setStcConfig('scheduledTasks.cleanBackups.lastRun', now);
            console.log(`[STC-MOD] Scheduled backup cleanup: removed ${cleaned} files`);
        } catch (e) {
            console.error('[STC-MOD] Scheduled cleanup error:', e.detail || e.message);
        }
    }, 60 * 1000); // Check every minute
    cleanupInterval.unref();
}

// Auto-start on module load
startScheduledCleanup();

export const router = express.Router();

// Admin: clean backup files for a specific user
router.post('/clean-backups', requireAdminMiddleware, async (req, res) => {
    try {
        const { handle } = req.body;
        const handles = handle ? [handle] : await getAllUserHandles();
        const { cleaned, freedBytes, failed } = await cleanBackupsOf(handles);

        res.json({
            success: true,
            cleaned,
            freedBytes,
            freedMiB: Math.round(freedBytes / 1024 / 1024 * 100) / 100,
            ...(failed.length ? { failed } : {}),
        });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: get scheduled tasks config
router.get('/config', requireAdminMiddleware, (req, res) => {
    res.json({
        cleanBackups: {
            enabled: getStcConfig('scheduledTasks.cleanBackups.enabled', false),
            intervalHours: getStcConfig('scheduledTasks.cleanBackups.intervalHours', 24),
            lastRun: getStcConfig('scheduledTasks.cleanBackups.lastRun', 0),
        },
    });
});

// Admin: save scheduled tasks config
router.post('/config', requireAdminMiddleware, (req, res) => {
    try {
        const { cleanBackups } = req.body;
        if (cleanBackups) {
            if (cleanBackups.enabled !== undefined) setStcConfig('scheduledTasks.cleanBackups.enabled', !!cleanBackups.enabled);
            if (cleanBackups.intervalHours !== undefined) setStcConfig('scheduledTasks.cleanBackups.intervalHours', Math.max(1, parseInt(cleanBackups.intervalHours) || 24));
        }
        res.json({ success: true });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: get storage analysis for all users (paginated)
// Query params: page (1-based, default 1), limit (default 30), search (handle substring), sortBy (name|storage)
router.get('/storage-analysis', requireAdminMiddleware, async (req, res) => {
    try {
        const page   = Math.max(1, parseInt(String(req.query.page  ?? '1')) || 1);
        const limit  = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '30')) || 30));
        const search = String(req.query.search ?? '').toLowerCase().trim();
        const sortBy = String(req.query.sortBy ?? 'name').toLowerCase(); // 'name' or 'storage'

        const allHandles = await getAllUserHandles();
        // Apply search filter on handle name first (cheap, no disk I/O)
        const filtered = search
            ? allHandles.filter(h => h.toLowerCase().includes(search))
            : allHandles;

        // Usage comes from the asynchronous usage cache (one walk per user, bounded concurrency,
        // never synchronous). The response is sent after a deadline with partial results: users
        // still being counted (or whose count failed) have `unknown: true` and null sizes.
        // Sorted by name, only the requested page is counted; sorted by storage, all users are.
        const offset = (page - 1) * limit;
        const byStorage = sortBy === 'storage';
        const sortedHandles = [...filtered].sort((a, b) => a.localeCompare(b));
        const counted = byStorage ? sortedHandles : sortedHandles.slice(offset, offset + limit);
        const usage = await getUsersUsage(counted);
        const toMiB = (b) => Math.round(b / 1024 / 1024 * 100) / 100;
        const KNOWN_DIRS = ['chats', 'characters', 'backups', 'worlds', 'themes'];

        const rows = counted.map((handle) => {
            const u = usage.get(handle);
            if (!u || u.bytes === null) {
                return { handle, totalBytes: null, totalMiB: null, categories: null, unknown: true, pending: !!u?.computing };
            }
            const cats = u.categories || {};
            const categoryBytes = Object.fromEntries(KNOWN_DIRS.map(dir => [dir, cats[dir] || 0]));
            const categorisedBytes = Object.values(categoryBytes).reduce((a, b) => a + b, 0);
            const otherBytes = Math.max(0, u.bytes - categorisedBytes);
            return {
                handle,
                totalBytes: u.bytes,
                totalMiB: toMiB(u.bytes),
                categories: {
                    chats: toMiB(categoryBytes.chats),
                    characters: toMiB(categoryBytes.characters),
                    backups: toMiB(categoryBytes.backups),
                    worlds: toMiB(categoryBytes.worlds),
                    themes: toMiB(categoryBytes.themes),
                    other: toMiB(otherBytes),
                },
                unknown: false,
                pending: u.pendingBytes > 0 || !u.fresh || u.computing,
                computedAt: u.computedAt,
            };
        });

        let pageData = rows;
        if (byStorage) {
            // High to low; unknown sizes last. Pagination after sorting
            rows.sort((a, b) => (b.totalBytes ?? -1) - (a.totalBytes ?? -1) || a.handle.localeCompare(b.handle));
            pageData = rows.slice(offset, offset + limit);
        }

        // Counts refer to the users counted for this response (all users when sorted by storage)
        const pendingCount = rows.filter(row => row.unknown && row.pending).length;
        res.json({
            total: filtered.length,
            page,
            limit,
            totalPages: Math.ceil(filtered.length / limit),
            data: pageData,
            pendingCount,
            unknownCount: rows.filter(row => row.unknown).length,
            complete: pendingCount === 0,
        });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});
