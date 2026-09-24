/**
 * SillyTavernchat Module - CSRF Exemption
 * Defines which custom paths should skip CSRF protection.
 */

const EXEMPT_PATHS = [
    '/api/stc/users/me',
    '/api/stc/users/heartbeat',
    '/api/stc/users/check-in',
    '/api/stc/users/use-storage-code',
    '/api/stc/users/renew',
    '/api/stc/users/renew-expired',
    '/api/stc/invitation-codes/status',
    '/api/stc/email/status',
    '/api/stc/announcements/login',
    '/api/stc/announcements/current',
];

// Note: /api/stc/oauth/* (complete-registration), /api/stc/users/register and
// /api/stc/users/send-verification are intentionally NOT exempt; register.html sends X-CSRF-Token.
/** @type {string[]} */
const EXEMPT_PREFIXES = [];

/**
 * Check if a request should skip CSRF protection
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function shouldSkipCsrf(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        return false; // GET/HEAD/OPTIONS already bypassed by csrf-sync
    }

    if (EXEMPT_PATHS.includes(req.path)) return true;

    for (const prefix of EXEMPT_PREFIXES) {
        if (req.path.startsWith(prefix)) return true;
    }

    return false;
}
