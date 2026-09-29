/**
 * SillyTavernchat Module - User Expiration Check Middleware
 * Checks if the logged-in user's account has expired.
 * Must be registered AFTER setUserDataMiddleware.
 * While the user metadata cannot be read it fails closed: 503 STORE_UNAVAILABLE for non-admin
 * users (only when the invitation code system is on; admins are never checked).
 */
import { isUserExpired, getUserMeta } from '../user-metadata.js';
import { getStcConfig } from '../config.js';
import { respondStoreError } from '../services/json-store.js';

/**
 * Express middleware that checks user account expiration.
 * If invitation codes are enabled and the user is expired, returns 401.
 */
export function expirationCheckMiddleware(req, res, next) {
    // Only check if invitation codes (subscription) system is enabled
    if (!getStcConfig('enableInvitationCodes', false)) {
        return next();
    }

    // Skip for unauthenticated requests
    if (!req.user?.profile?.handle) {
        return next();
    }

    const handle = req.user.profile.handle;

    // Skip for admin users
    if (req.user.profile.admin) {
        return next();
    }

    let expired;
    let meta;
    try {
        expired = isUserExpired(handle);
        meta = getUserMeta(handle);
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        throw error;
    }

    if (expired) {
        const purchaseLink = getStcConfig('purchaseLink', '');

        // Clear session to force re-login
        if (req.session) {
            req.session = null;
        }

        return res.status(401).json({
            error: true,
            expired: true,
            message: '您的账户已过期，请续费后继续使用',
            purchaseLink: purchaseLink || undefined,
            expiresAt: meta?.expiresAt,
        });
    }

    // Attach extended metadata to request for downstream use
    req.stcUserMeta = meta;
    next();
}
