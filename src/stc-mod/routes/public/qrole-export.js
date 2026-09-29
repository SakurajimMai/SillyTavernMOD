/**
 * SillyTavernchat Module - QRole export-only access (public API)
 * Mounted at /api/stc/qrole-export BEFORE the login requirement. Every endpoint is bound to the
 * export session created by the QRole OAuth callback (see services/qrole-export.js); it grants a
 * status read, the official data backup archive of that one account, and logout. Nothing else.
 */
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { createBackupArchive } from '../../../users.js';
import { retryAfter } from '../../../express-common.js';
import {
    EXPORT_EXPIRED_CODE,
    EXPORT_EXPIRED_MESSAGE,
    clearExportSession,
    isFullBackupAllowed,
    resolveExportSession,
} from '../../services/qrole-export.js';
import {
    computeCleanupAt,
    getQroleAccountState,
    getQroleConfig,
    resolveQroleLifecycleConfig,
    toTimestamp,
} from '../../services/qrole-lifecycle.js';
import { respondStoreError } from '../../services/json-store.js';

export const router = express.Router();

// At most 3 archives per hour per account, and one at a time
const archiveLimiter = new RateLimiterMemory({ points: 3, duration: 60 * 60 });
/** @type {Set<string>} */
const activeArchives = new Set();

router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

/**
 * Reject a request without a valid export session (and drop an invalid one).
 * Browser navigations are sent to the login page, API calls get 401 JSON.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{status: string}} state
 */
function rejectExport(req, res, state) {
    if (state.status === 'invalid') clearExportSession(req);
    if (req.method === 'GET' && req.accepts(['json', 'html']) === 'html') {
        return res.redirect('/login?oauth_error=export_expired');
    }
    return res.status(401).json({ error: EXPORT_EXPIRED_MESSAGE, code: EXPORT_EXPIRED_CODE });
}

// Account and membership shown on /qrole-expired
router.get('/status', async (req, res) => {
    try {
        const state = await resolveExportSession(req);
        if (state.status !== 'valid') return rejectExport(req, res, state);

        const cfg = getQroleConfig();
        const lifecycle = resolveQroleLifecycleConfig(cfg);
        const { meta, session } = state;
        const accountState = getQroleAccountState(meta, cfg, Date.now());
        return res.json({
            handle: session.handle,
            reason: session.reason,
            tier: typeof meta.qroleTier === 'string' && meta.qroleTier ? meta.qroleTier : null,
            tierName: typeof meta.qroleTierName === 'string' && meta.qroleTierName ? meta.qroleTierName : null,
            expiresAt: toTimestamp(meta.qroleMembershipExpiresAt),
            renewUrl: lifecycle.renewUrl,
            cleanupAt: computeCleanupAt(meta, accountState, lifecycle.expiredCleanup),
            exportAvailable: isFullBackupAllowed(),
        });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole export status error:', error);
        return res.status(500).json({ error: '获取账号信息失败，请稍后重试' });
    }
});

// Download the account's data (the official full backup archive; secrets excluded like there)
router.get('/archive', async (req, res) => {
    try {
        const state = await resolveExportSession(req);
        if (state.status !== 'valid') return rejectExport(req, res, state);

        if (!isFullBackupAllowed()) {
            return res.status(403).json({ error: '管理员已关闭完整数据备份，暂时无法导出', code: 'EXPORT_DISABLED' });
        }

        const handle = state.session.handle;
        if (activeArchives.has(handle)) {
            return res.status(409).json({ error: '数据正在打包下载中，请等待当前下载完成后再试', code: 'EXPORT_BUSY' });
        }
        try {
            await archiveLimiter.consume(handle);
        } catch (rateLimit) {
            if (!(rateLimit instanceof RateLimiterRes)) throw rateLimit;
            return retryAfter(res, rateLimit).status(429).json({ error: '导出过于频繁，每小时最多导出 3 次，请稍后再试', code: 'EXPORT_RATE_LIMITED' });
        }

        activeArchives.add(handle);
        // The archive streams after createBackupArchive returns; 'close' fires on completion and on abort
        res.once('close', () => activeArchives.delete(handle));
        console.info(`[STC-MOD] QRole export-only data download for ${handle}`);
        try {
            await createBackupArchive(handle, res);
        } catch (error) {
            activeArchives.delete(handle);
            throw error;
        }
    } catch (error) {
        if (!res.headersSent && respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole export archive error:', error);
        if (!res.headersSent) return res.status(500).json({ error: '导出失败，请稍后重试' });
        res.end();
    }
});

// Leave the export page
router.post('/logout', (req, res) => {
    clearExportSession(req);
    return res.json({ success: true });
});
