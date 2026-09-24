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
    '/api/stc/users/register',
    '/api/stc/users/send-verification',
    '/api/stc/invitation-codes/status',
    '/api/stc/oauth',
    '/api/stc/email/status',
    '/api/stc/announcements/login',
    '/api/stc/announcements/current',
];

const EXEMPT_PREFIXES = [
    '/api/stc/oauth/',
];

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
