/**
 * SillyTavernchat Module - QRole session guard
 *
 * QRole membership is checked in the OAuth callback, but sessions outlive it (the official cookie
 * lasts up to 400 days). This guard re-checks the membership snapshot stored at login
 * (qroleTier, qroleMembershipExpiresAt, qroleCheckedAt) on every request of a QRole account.
 * The re-verification deadline applies to page loads; API calls get twice the window, so a chat
 * that is in progress is not cut off mid-request.
 *
 * When the snapshot is no longer valid and the account has a usable QRole refresh token (background
 * re-verification, `oauth.qrole.backgroundReverify`), the membership is re-checked with QRole first:
 * renewed members simply continue. Otherwise (or when QRole still says the membership lapsed) the
 * session ends: the membership expired, the tier is no longer allowed, or the snapshot is too old
 * (forcing a fresh QRole login). While QRole is unreachable, a snapshot that is merely due for
 * re-verification is honored for up to twice the window; expired / non-member snapshots are not.
 * Right after QRole itself reported the lapse (5 minutes), replayed old session cookies are refused
 * without asking QRole again.
 * Must be registered AFTER setUserDataMiddleware (needs req.user).
 *
 * While the user metadata cannot be read (StoreUnavailableError) the guard fails closed: requests of
 * logged-in non-admin users answer 503 STORE_UNAVAILABLE (nobody can tell whether the account is a
 * QRole account). Exceptions: admins, and every request while `oauth.qrole.requireMembership` is
 * off (the guard needs no metadata then).
 */
import { getUserMeta } from '../user-metadata.js';
import { liveMetaForRecord } from './account-security.js';
import { respondStoreError } from './json-store.js';
import {
    decideQroleSession,
    getQroleConfig,
    hasStoredRefreshToken,
    isRefreshTokenFeatureOn,
    resolveQroleLifecycleConfig,
    QROLE_SESSION_MESSAGES,
} from './qrole-lifecycle.js';
import { isVerificationCoolingDown, verifyQroleMembership } from './qrole-reverify.js';

// The pure session evaluation lives in qrole-lifecycle.js (unit-testable); re-exported for callers
export { DEFAULT_REVERIFY_HOURS, QROLE_SESSION_MESSAGES, evaluateQroleSession } from './qrole-lifecycle.js';

/**
 * End sessions of QRole accounts whose membership is no longer valid.
 * API requests get 401 JSON, page (GET) requests are redirected to the login page;
 * other requests continue without a user (later auth middleware rejects them).
 * Admins, non-QRole accounts and accounts with stale metadata are never affected.
 * @type {import('express').RequestHandler}
 */
export async function qroleSessionGuard(req, res, next) {
    try {
        const profile = req.user?.profile;
        if (!profile || profile.admin) return next();

        const cfg = getQroleConfig();
        if (cfg.requireMembership === false) return next();

        const handle = profile.handle;
        const meta = liveMetaForRecord(getUserMeta(handle), profile);
        if (meta?.oauthProvider !== 'qrole') return next();

        const isApi = String(req.path).toLowerCase().startsWith('/api/');
        const now = Date.now();
        const lifecycle = resolveQroleLifecycleConfig(cfg);
        const { valid, reason } = await decideQroleSession({
            meta,
            cfg,
            now,
            isApi,
            verifyAvailable: isRefreshTokenFeatureOn(lifecycle) && hasStoredRefreshToken(meta, now),
            inCooldown: isVerificationCoolingDown(handle, now),
            verify: () => verifyQroleMembership(handle, { reason: 'session' }),
            reloadMeta: () => liveMetaForRecord(getUserMeta(handle), profile),
        });
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
        // Metadata unavailable: fail closed (503) instead of letting a possibly lapsed session through
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] QRole session guard error:', error);
        return next();
    }
}
