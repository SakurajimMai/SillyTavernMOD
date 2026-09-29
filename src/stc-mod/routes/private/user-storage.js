/**
 * SillyTavernchat Module - User Storage Management (Admin)
 * Store failures (user metadata, storage codes) answer 503 STORE_UNAVAILABLE (services/json-store.js).
 */
import express from 'express';
import { requireAdminMiddleware } from '../../../users.js';
import { getStcConfig, setStcConfig } from '../../config.js';
import {
    buildStorageInfo, getUsersUsage, invalidateAllUsage, invalidateUserUsage, isStorageLimitEnabled,
    generateStorageCodes, getAllStorageCodes, deleteStorageCode,
} from '../../services/storage-quota.js';
import { getAllUserMeta, setUserMeta } from '../../user-metadata.js';
import { respondStoreError } from '../../services/json-store.js';

export const router = express.Router();

// Admin: get storage config
router.get('/config', requireAdminMiddleware, (req, res) => {
    res.json({
        enabled: isStorageLimitEnabled(),
        defaultLimitMiB: getStcConfig('userStorage.defaultLimitMiB', 500),
        dailyCheckInMiB: getStcConfig('userStorage.dailyCheckInMiB', 0),
    });
});

// Admin: update storage config
router.post('/config', requireAdminMiddleware, (req, res) => {
    try {
        const { enabled, defaultLimitMiB, dailyCheckInMiB } = req.body;
        if (enabled !== undefined) {
            // Usage is not tracked while the quota is off: count again when it is switched on
            if (!!enabled && !isStorageLimitEnabled()) invalidateAllUsage();
            setStcConfig('userStorage.enabled', !!enabled);
        }
        if (defaultLimitMiB !== undefined) setStcConfig('userStorage.defaultLimitMiB', parseInt(defaultLimitMiB) || 500);
        if (dailyCheckInMiB !== undefined) setStcConfig('userStorage.dailyCheckInMiB', parseInt(dailyCheckInMiB) || 0);
        res.json({ success: true });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: get all users storage info. Usage comes from the asynchronous cache: stale values are
// recounted with bounded concurrency and the response is sent after a deadline with partial results
// (`unknown: true` / `pending: true` entries; reload later for the rest).
router.get('/all-users', requireAdminMiddleware, async (req, res) => {
    try {
        const allMeta = getAllUserMeta();
        const handles = Object.keys(allMeta);
        if (!isStorageLimitEnabled()) {
            return res.json(handles.map(handle => ({ handle, enabled: false })));
        }
        const usage = await getUsersUsage(handles);
        const result = handles.map(handle => ({
            handle,
            ...buildStorageInfo(handle, usage.get(handle)),
        }));
        res.json(result);
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: set user storage limit
router.post('/set-limit', requireAdminMiddleware, (req, res) => {
    try {
        const { handle, limitMiB } = req.body;
        if (!handle) return res.status(400).json({ error: '缺少用户标识' });
        setUserMeta(handle, { storageLimitMiB: parseInt(limitMiB) || 500 });
        invalidateUserUsage(handle);
        res.json({ success: true });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: generate storage expansion codes
router.post('/generate-codes', requireAdminMiddleware, (req, res) => {
    try {
        const { count, amountMiB } = req.body;
        const codes = generateStorageCodes(
            Math.min(parseInt(count) || 1, 100),
            parseInt(amountMiB) || 100,
            req.user.profile.handle,
        );
        res.json({ success: true, codes });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: list storage codes
router.get('/codes', requireAdminMiddleware, (req, res) => {
    try {
        res.json(getAllStorageCodes());
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: delete storage code
router.post('/delete-code', requireAdminMiddleware, (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: '缺少激活码' });
    try {
        res.json({ success: deleteStorageCode(code) });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});
