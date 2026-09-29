/**
 * SillyTavernchat Module - QRole membership status of the current user
 * Mounted at /api/stc/qrole (authenticated). Feeds the expiry reminder banner of the STC panel.
 * Never returns the refresh token itself.
 */
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { retryAfter } from '../../../express-common.js';
import { getUserMeta } from '../../user-metadata.js';
import { liveMetaForRecord } from '../../services/account-security.js';
import { isTokenKeyAvailable } from '../../services/qrole-token-crypto.js';
import { verifyQroleMembership } from '../../services/qrole-reverify.js';
import {
    DAY_MS,
    decideQroleSession,
    getQroleConfig,
    hasStoredRefreshToken,
    isRefreshTokenFeatureOn,
    isTierAllowed,
    normalizeTier,
    resolveQroleLifecycleConfig,
    toTimestamp,
} from '../../services/qrole-lifecycle.js';
import { respondStoreError } from '../../services/json-store.js';

export const router = express.Router();

// 「我已续费，刷新状态」: one QRole round trip per account and minute
const refreshLimiter = new RateLimiterMemory({ points: 1, duration: 60 });

/**
 * Live QRole metadata of the logged-in (non-admin) user, or null.
 * @param {object|undefined} profile req.user.profile
 * @returns {object|null}
 */
function getQroleMeta(profile) {
    if (!profile || profile.admin) return null;
    const meta = liveMetaForRecord(getUserMeta(profile.handle), profile);
    return meta?.oauthProvider === 'qrole' ? meta : null;
}

/**
 * Status of the logged-in user (`{qrole: false}` for admins and non-QRole accounts).
 * @param {object|undefined} profile req.user.profile
 * @returns {object}
 */
function buildStatus(profile) {
    const meta = getQroleMeta(profile);
    if (!meta) return { qrole: false };

    const cfg = getQroleConfig();
    const lifecycle = resolveQroleLifecycleConfig(cfg);
    const now = Date.now();
    const tier = normalizeTier(meta.qroleTier);
    const expiresAt = toTimestamp(meta.qroleMembershipExpiresAt);
    const backgroundReverify = isRefreshTokenFeatureOn(lifecycle);
    const hasRefreshToken = backgroundReverify && hasStoredRefreshToken(meta, now) && isTokenKeyAvailable();
    return {
        qrole: true,
        tier,
        tierName: typeof meta.qroleTierName === 'string' && meta.qroleTierName ? meta.qroleTierName : null,
        tierAllowed: isTierAllowed(tier, cfg),
        expiresAt,
        checkedAt: toTimestamp(meta.qroleCheckedAt),
        daysLeft: expiresAt === null ? null : Math.ceil((expiresAt - now) / DAY_MS),
        // Without the membership gate an expiry has no effect here, so there is nothing to remind of
        reminderDays: lifecycle.requireMembership ? lifecycle.expiryReminderDays : 0,
        renewUrl: lifecycle.renewUrl,
        backgroundReverify,
        hasRefreshToken,
        refreshTokenExpiresAt: hasRefreshToken ? meta.qroleRefreshTokenExpiresAt : null,
    };
}

router.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        return res.json(buildStatus(req.user?.profile));
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole status error:', error);
        return res.status(500).json({ error: '获取会员状态失败' });
    }
});

router.post('/refresh-status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const profile = req.user?.profile;
        if (!profile) return res.status(401).json({ error: 'Not authenticated' });
        if (!getQroleMeta(profile)) {
            return res.status(400).json({ error: '当前账号不是 QRole 会员账号' });
        }

        try {
            await refreshLimiter.consume(profile.handle);
        } catch (rateLimit) {
            if (!(rateLimit instanceof RateLimiterRes)) throw rateLimit;
            return retryAfter(res, rateLimit).status(429).json({ error: '刷新过于频繁，请 1 分钟后再试' });
        }

        const verification = await verifyQroleMembership(profile.handle, { reason: 'user', ignoreCooldown: true });
        const status = buildStatus(profile);
        const meta = getQroleMeta(profile);
        // What the session guard decides on the next page load, given the check that just ran
        // (e.g. a transient failure keeps a snapshot that is only due for re-verification alive)
        const { valid, reason } = await decideQroleSession({
            meta,
            cfg: getQroleConfig(),
            now: Date.now(),
            isApi: false,
            verifyAvailable: true,
            inCooldown: false,
            verify: async () => verification,
            reloadMeta: () => meta,
        });
        return res.json({
            result: verification.result,
            status,
            valid,
            reason,
            verifyReason: verification.reason,
        });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole refresh-status error:', error);
        return res.status(500).json({ error: '刷新会员状态失败，请稍后重试' });
    }
});
