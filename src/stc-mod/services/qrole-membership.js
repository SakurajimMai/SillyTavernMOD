/**
 * SillyTavernchat Module - QRole membership gate
 *
 * Decides whether a QRole (qqy.one) OAuth identity may log in, based on its userinfo claims:
 * account status, membership tier and membership expiry. Pure functions (no I/O), fail closed:
 * a missing or empty tier claim or an unparsable expiry never grants access.
 */

/** Tiers allowed when `oauth.qrole.allowedTiers` is not configured. */
export const DEFAULT_ALLOWED_TIERS = Object.freeze(['vip', 'svip']);

/** Claim paths searched (in order) for the membership tier when none are configured. */
export const DEFAULT_TIER_CLAIMS = Object.freeze(['membershipTierId', 'membership_tier', 'membership.tierId', 'membership.tier', 'tier']);

/** Claim paths searched (in order) for the membership expiry when none are configured. */
export const DEFAULT_EXPIRY_CLAIMS = Object.freeze(['membershipExpiresAt', 'membership_expires_at', 'membership.expiresAt']);

// Epoch values below this are treated as seconds (1e12 ms ≈ year 2001, 1e12 s is far in the future)
const SECONDS_THRESHOLD = 1e12;

/**
 * @typedef {Object} QroleMembershipResult
 * @property {boolean} allowed Whether the identity may log in
 * @property {null|'not_member'|'membership_expired'|'membership_unknown'|'account_suspended'} code Deny reason
 * @property {string|null} tier Normalized (trimmed, lowercase) tier, if found
 * @property {number|null} expiresAt Membership expiry in ms, if known
 */

/**
 * Look up a dotted path (e.g. `membership.tierId`) in an object, following own properties only.
 * @param {object} obj Source object (userinfo claims)
 * @param {string} path Dot-separated path
 * @returns {*} The value, or undefined if any segment is missing
 */
export function getClaim(obj, path) {
    if (obj === null || typeof obj !== 'object' || typeof path !== 'string' || !path) return undefined;
    let current = obj;
    for (const part of path.split('.')) {
        if (!part || current === null || typeof current !== 'object') return undefined;
        if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Normalize a config list: array of strings, or a comma-separated string.
 * @param {*} value Configured value
 * @returns {string[]|null} Trimmed non-empty entries, or null if the value is not a list
 */
function toStringList(value) {
    if (Array.isArray(value)) {
        return value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    return null;
}

/**
 * Allowed membership tiers from config, lowercased. Only a missing key (undefined/null) falls
 * back to the defaults; an explicit empty or invalid value allows no tier at all (fail closed).
 * Shared by the login check and the session guard so both apply the same policy.
 * @param {*} value `oauth.qrole.allowedTiers`
 * @returns {string[]}
 */
export function normalizeAllowedTiers(value) {
    if (value === undefined || value === null) return [...DEFAULT_ALLOWED_TIERS];
    return (toStringList(value) || []).map(item => item.toLowerCase());
}

/**
 * Claim path list from config, falling back to the defaults when missing or empty.
 * @param {*} value Configured value
 * @param {readonly string[]} fallback Default paths
 * @returns {string[]}
 */
function getClaimPaths(value, fallback) {
    const list = toStringList(value);
    return list && list.length ? list : [...fallback];
}

/**
 * Convert an epoch number to milliseconds (values below 1e12 are seconds).
 * @param {number} value Epoch value
 * @returns {number}
 */
function toEpochMs(value) {
    return value < SECONDS_THRESHOLD ? value * 1000 : value;
}

/**
 * Parse a membership expiry claim.
 * @param {*} value Raw claim value
 * @returns {{ok: boolean, value: number|null}} ok=false when the value is present but unparsable
 */
function parseExpiry(value) {
    if (value === undefined || value === null || value === '') return { ok: true, value: null };
    if (typeof value === 'number') {
        return Number.isFinite(value) ? { ok: true, value: toEpochMs(value) } : { ok: false, value: null };
    }
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return { ok: true, value: null };
        if (/^-?\d+(\.\d+)?$/.test(text)) {
            const numeric = Number(text);
            return Number.isFinite(numeric) ? { ok: true, value: toEpochMs(numeric) } : { ok: false, value: null };
        }
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false, value: null };
    }
    return { ok: false, value: null };
}

/**
 * Evaluate whether a QRole identity may log in.
 * @param {object} claims QRole userinfo response
 * @param {object} cfg `oauth.qrole` config (requireMembership, allowedTiers, tierClaims, expiryClaims)
 * @param {number} [now] Current time in ms
 * @returns {QroleMembershipResult}
 */
export function evaluateQroleMembership(claims, cfg, now = Date.now()) {
    const source = claims && typeof claims === 'object' ? claims : {};
    const config = cfg && typeof cfg === 'object' ? cfg : {};

    // Tier: first configured path holding a non-empty string. A path that is present but empty
    // ('' / null) means "no membership" (free user), as opposed to an unknown claim format.
    let tier = null;
    let tierEmpty = false;
    for (const path of getClaimPaths(config.tierClaims, DEFAULT_TIER_CLAIMS)) {
        const value = getClaim(source, path);
        if (typeof value === 'string' && value.trim()) {
            tier = value.trim().toLowerCase();
            break;
        }
        if (value === null || typeof value === 'string') {
            tierEmpty = true;
        }
    }

    // Expiry: first configured path that is present at all
    let expiry = { ok: true, value: null };
    for (const path of getClaimPaths(config.expiryClaims, DEFAULT_EXPIRY_CLAIMS)) {
        const value = getClaim(source, path);
        if (value !== undefined) {
            expiry = parseExpiry(value);
            break;
        }
    }
    const expiresAt = expiry.ok && expiry.value ? expiry.value : null;

    /** @type {(code: QroleMembershipResult['code']) => QroleMembershipResult} */
    const deny = code => ({ allowed: false, code, tier, expiresAt });

    const status = [getClaim(source, 'status'), getClaim(source, 'accountStatus')].find(value => typeof value === 'string');
    if (status !== undefined && status.trim().toLowerCase() !== 'active') {
        return deny('account_suspended');
    }

    if (config.requireMembership === false) {
        return { allowed: true, code: null, tier, expiresAt };
    }

    if (!tier) {
        return deny(tierEmpty ? 'not_member' : 'membership_unknown');
    }

    const allowedTiers = normalizeAllowedTiers(config.allowedTiers);
    if (!allowedTiers.includes(tier)) {
        return deny('not_member');
    }

    if (!expiry.ok) {
        return deny('membership_unknown');
    }
    if (expiresAt && expiresAt <= now) {
        return deny('membership_expired');
    }

    return { allowed: true, code: null, tier, expiresAt };
}

/**
 * Describe the top-level claim KEY NAMES of a userinfo response (never values), for diagnostics.
 * @param {object} claims QRole userinfo response
 * @returns {string} Sorted, comma-separated key names
 */
export function describeClaimKeys(claims) {
    if (!claims || typeof claims !== 'object') return '(none)';
    const keys = Object.keys(claims)
        .map(key => key.replace(/[^\w.:-]/g, '?').slice(0, 64))
        .sort()
        .slice(0, 100);
    return keys.length ? keys.join(', ') : '(none)';
}
