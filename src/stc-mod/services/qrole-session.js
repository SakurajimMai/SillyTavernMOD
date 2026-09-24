/**
 * SillyTavernchat Module - QRole session guard
 *
 * QRole membership is checked in the OAuth callback, but sessions outlive it (the official cookie
 * lasts up to 400 days). This guard re-checks the membership snapshot stored at login
 * (qroleTier, qroleMembershipExpiresAt, qroleCheckedAt) on every request of a QRole account and
 * ends the session once the membership expired, the tier is no longer allowed, or the snapshot is
 * older than `oauth.qrole.reverifyHours` (forcing a fresh QRole login and thus a fresh check).
 * The re-verification deadline applies to page loads; API calls get twice the window, so a chat
 * that is in progress is not cut off mid-request (the next reload asks for a fresh login).
 * Must be registered AFTER setUserDataMiddleware (needs req.user).
 */
import { getStcConfig } from '../config.js';
import { getUserMeta } from '../user-metadata.js';
import { liveMetaForRecord } from './account-security.js';
import { normalizeAllowedTiers } from './qrole-membership.js';

/** Re-verification window (hours) when `oauth.qrole.reverifyHours` is not configured. */
export const DEFAULT_REVERIFY_HOURS = 24;

/** API error messages per invalid-session reason (same wording as the login page). */
export const QROLE_SESSION_MESSAGES = Object.freeze({
    membership_expired: '您的 QRole 会员已过期，续费后即可登录',
    not_member: '仅 QRole VIP / SVIP 会员可以登录',
    membership_reverify: '为确认会员状态，请重新使用 QRole 登录',
});

/**
 * @typedef {Object} QroleSessionResult
 * @property {boolean} valid Whether the session may continue
 * @property {null|'membership_expired'|'not_member'|'membership_reverify'} reason Why it is invalid
 */

/**
 * Re-verification window in hours from config (non-numeric → default; ≤ 0 disables the rule).
 * @param {*} value `oauth.qrole.reverifyHours`
 * @returns {number}
 */
function getReverifyHours(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_REVERIFY_HOURS;
    const hours = Number(value);
    return Number.isFinite(hours) ? hours : DEFAULT_REVERIFY_HOURS;
}

/**
 * Evaluate whether a QRole account's session is still backed by a valid membership snapshot.
 * @param {object|null|undefined} meta STC metadata of the (live) QRole account
 * @param {object|null|undefined} cfg `oauth.qrole` config (requireMembership, allowedTiers, reverifyHours)
 * @param {number} [now] Current time in ms
 * @param {{isApi?: boolean}} [opts] API requests get a doubled re-verification window
 * @returns {QroleSessionResult}
 */
export function evaluateQroleSession(meta, cfg, now = Date.now(), opts = {}) {
    const data = meta && typeof meta === 'object' ? meta : {};
    const config = cfg && typeof cfg === 'object' ? cfg : {};

    if (config.requireMembership === false) {
        return { valid: true, reason: null };
    }

    const expiresAt = data.qroleMembershipExpiresAt;
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now) {
        return { valid: false, reason: 'membership_expired' };
    }

    const tier = typeof data.qroleTier === 'string' ? data.qroleTier.trim().toLowerCase() : '';
    if (!tier || !normalizeAllowedTiers(config.allowedTiers).includes(tier)) {
        return { valid: false, reason: 'not_member' };
    }

    const reverifyHours = getReverifyHours(config.reverifyHours);
    if (reverifyHours > 0) {
        const windowMs = reverifyHours * 3600 * 1000 * (opts.isApi ? 2 : 1);
        const checkedAt = data.qroleCheckedAt;
        const hasCheckedAt = typeof checkedAt === 'number' && Number.isFinite(checkedAt);
        if (!hasCheckedAt || now - checkedAt > windowMs) {
            return { valid: false, reason: 'membership_reverify' };
        }
    }

    return { valid: true, reason: null };
}

/**
 * End sessions of QRole accounts whose membership is no longer valid.
 * API requests get 401 JSON, page (GET) requests are redirected to the login page;
 * other requests continue without a user (later auth middleware rejects them).
 * Admins, non-QRole accounts and accounts with stale metadata are never affected.
 * @type {import('express').RequestHandler}
 */
export function qroleSessionGuard(req, res, next) {
    try {
        const profile = req.user?.profile;
        if (!profile || profile.admin) return next();

        const meta = liveMetaForRecord(getUserMeta(profile.handle), profile);
        if (meta?.oauthProvider !== 'qrole') return next();

        const raw = getStcConfig('oauth.qrole', {});
        const cfg = raw && typeof raw === 'object' ? raw : {};
        if (cfg.requireMembership === false) return next();

        const isApi = String(req.path).toLowerCase().startsWith('/api/');
        const { valid, reason } = evaluateQroleSession(meta, cfg, Date.now(), { isApi });
        if (valid) return next();

        // Destroy the session (cookie-session clears the cookie) and drop the user
        req.session = null;
        req.user = undefined;

        if (isApi) {
            return res.status(401).json({ error: QROLE_SESSION_MESSAGES[reason], code: 'QROLE_MEMBERSHIP', reason });
        }
        if (req.method === 'GET') {
            return res.redirect('/login?oauth_error=' + encodeURIComponent(reason));
        }
        return next();
    } catch (error) {
        console.error('[STC-MOD] QRole session guard error:', error);
        return next();
    }
}
