/**
 * SillyTavernchat Module - QRole account management (Admin)
 * Mounted at /api/stc/qrole-accounts. Lists QRole-linked accounts with their membership state,
 * re-verifies single accounts and previews / runs the expired-account cleanup (optionally in the
 * background).
 * Deleting accounts stays on /api/stc/users/delete-single and /delete-batch.
 */
import express from 'express';
import { requireAdminMiddleware } from '../../../users.js';
import { verifyQroleMembership } from '../../services/qrole-reverify.js';
import {
    getQroleAccountEntry,
    getQroleCleanupStatus,
    listQroleAccounts,
    previewQroleCleanup,
    runQroleCleanup,
} from '../../services/qrole-cleanup.js';
import { respondStoreError } from '../../services/json-store.js';

export const router = express.Router();

const NOT_FOUND_MESSAGE = '未找到该 QRole 账号';

/** Messages when a manual cleanup run cannot start. */
const CLEANUP_NOT_STARTED = Object.freeze({
    running: { status: 409, code: 'CLEANUP_RUNNING', error: '清理任务正在运行，请稍后再试' },
    disabled: { status: 400, code: 'CLEANUP_DISABLED', error: '请先开启「过期账号自动清理」并保存设置' },
    membership_not_required: { status: 400, code: 'MEMBERSHIP_NOT_REQUIRED', error: '未开启「仅允许会员登录」，不会清理 QRole 账号' },
});

router.use(requireAdminMiddleware);
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// Admin: all QRole accounts + cleanup settings / last run
router.get('/', async (req, res) => {
    try {
        return res.json(await listQroleAccounts());
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole account list error:', error);
        return res.status(500).json({ error: '获取 QRole 账号列表失败' });
    }
});

// Admin: re-verify one account with its stored refresh token now
router.post('/verify', async (req, res) => {
    try {
        const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim() : '';
        if (!handle) return res.status(400).json({ error: '缺少用户名' });
        if (!await getQroleAccountEntry(handle)) return res.status(404).json({ error: NOT_FOUND_MESSAGE });

        const verification = await verifyQroleMembership(handle, { reason: 'admin', ignoreCooldown: true });
        const account = await getQroleAccountEntry(handle);
        if (!account) return res.status(404).json({ error: NOT_FOUND_MESSAGE });
        return res.json({ result: verification.result, reason: verification.reason, account });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole account verify error:', error);
        return res.status(500).json({ error: '复核失败，请稍后重试' });
    }
});

// Admin: accounts the next cleanup run would delete (no network re-verification)
router.post('/cleanup/preview', async (req, res) => {
    try {
        return res.json(await previewQroleCleanup());
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole cleanup preview error:', error);
        return res.status(500).json({ error: '预览失败，请稍后重试' });
    }
});

// Admin: whether a cleanup run is in progress + the last finished run (polled after a background run)
router.get('/cleanup/status', (req, res) => {
    try {
        return res.json(getQroleCleanupStatus());
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole cleanup status error:', error);
        return res.status(500).json({ error: '获取清理状态失败' });
    }
});

// Admin: run the cleanup job now (same code path as the scheduler).
// `{ background: true }` answers 202 as soon as the run started (the admin panel then polls
// GET /cleanup/status); otherwise the response is the result of the finished run.
router.post('/cleanup/run', async (req, res) => {
    try {
        const background = req.body?.background === true;
        const run = await runQroleCleanup({ trigger: 'manual', background });
        if (!run.started) {
            const { status, code, error } = CLEANUP_NOT_STARTED[run.reason];
            return res.status(status).json({ error, code });
        }
        if ('background' in run) {
            return res.status(202).json({ started: true, running: true, startedAt: run.startedAt });
        }
        return res.json(run.result);
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole cleanup run error:', error);
        return res.status(500).json({ error: '清理失败，请稍后重试' });
    }
});
