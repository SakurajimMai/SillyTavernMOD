/**
 * SillyTavernchat Module - QRole membership lifecycle (pure logic)
 *
 * Everything the expiry handling decides without I/O: the lifecycle config keys under
 * `oauth.qrole` (read through ONE helper, with code defaults), the session evaluation used by the
 * guard, the account state (active / expired / not_member) and cleanup date, how a fresh
 * membership result is merged into the stored snapshot, and the guard decision once a background
 * re-verification is possible. Only `getQroleConfig()` touches config.yaml; all other functions
 * take their inputs as parameters so they can be unit tested.
 */
import { getStcConfig } from '../config.js';
import { evaluateQroleMembership, normalizeAllowedTiers } from './qrole-membership.js';
import { getQroleTierName } from './oauth-client.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Re-verification window (hours) when `oauth.qrole.reverifyHours` is not configured. */
export const DEFAULT_REVERIFY_HOURS = 24;
export const DEFAULT_RENEW_URL = 'https://www.qqy.one/membership';
export const DEFAULT_EXPIRY_REMINDER_DAYS = 7;
export const MAX_EXPIRY_REMINDER_DAYS = 60;
export const DEFAULT_CLEANUP_AFTER_DAYS = 90;
export const MIN_CLEANUP_AFTER_DAYS = 30;
export const MAX_CLEANUP_AFTER_DAYS = 3650;
/** Refresh token lifetime assumed when QRole does not report refresh_token_expires_in. */
export const REFRESH_TOKEN_DEFAULT_TTL_MS = 30 * DAY_MS;
/** Upper bound for the stored refresh token lifetime, whatever QRole reports. */
export const REFRESH_TOKEN_MAX_TTL_MS = 90 * DAY_MS;
/**
 * After QRole itself reported no valid membership (background check or denied login), sessions of
 * the account are not re-verified again for this long: replayed old session cookies of a lapsed
 * member would otherwise cost a refresh grant + userinfo round trip per request.
 */
export const LAPSE_RECHECK_PAUSE_MS = 5 * 60 * 1000;
const MAX_RENEW_URL_LENGTH = 2048;

/** Metadata keys holding the (encrypted) QRole refresh token. */
export const REFRESH_TOKEN_META_KEYS = Object.freeze(['qroleRefreshToken', 'qroleRefreshTokenExpiresAt']);

/** API error messages per invalid-session reason (same wording as the login page). */
export const QROLE_SESSION_MESSAGES = Object.freeze({
    membership_expired: '您的 QRole 会员已过期，续费后即可登录',
    not_member: '仅 QRole VIP / SVIP 会员可以登录',
    membership_reverify: '为确认会员状态，请重新使用 QRole 登录',
});

/**
 * @typedef {Object} QroleLifecycleConfig
 * @property {boolean} requireMembership `requireMembership !== false`
 * @property {boolean} backgroundReverify Keep the refresh token and re-verify in the background
 * @property {string} renewUrl http(s) link of the QRole membership page
 * @property {number} expiryReminderDays Banner lead time in days (0 = off), 0-60
 * @property {boolean} expiredDataExport Expired / non-member accounts may use the export-only page
 * @property {{enabled: boolean, afterDays: number}} expiredCleanup Automatic deletion of lapsed accounts
 * @property {number} reverifyHours Snapshot re-verification window (≤ 0 disables the rule)
 */

/**
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {*} value
 * @returns {value is number} Finite number
 */
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Timestamp (ms) or null.
 * @param {*} value
 * @returns {number|null}
 */
export function toTimestamp(value) {
    return isFiniteNumber(value) ? value : null;
}

/**
 * Numeric config value (numbers or numeric strings), or NaN.
 * @param {*} value
 * @returns {number}
 */
function toNumber(value) {
    if (isFiniteNumber(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return NaN;
}

/**
 * Re-verification window in hours from config (non-numeric → default; ≤ 0 disables the rule).
 * @param {*} value `oauth.qrole.reverifyHours`
 * @returns {number}
 */
export function getReverifyHours(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_REVERIFY_HOURS;
    const hours = Number(value);
    return Number.isFinite(hours) ? hours : DEFAULT_REVERIFY_HOURS;
}

/**
 * Whether a value is an absolute http(s) URL.
 * @param {*} value
 * @returns {boolean}
 */
export function isHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_RENEW_URL_LENGTH) return false;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Renewal link: a configured http(s) URL, otherwise the QRole membership page.
 * @param {*} value `oauth.qrole.renewUrl`
 * @returns {string}
 */
export function normalizeRenewUrl(value) {
    return isHttpUrl(value) ? String(value).trim() : DEFAULT_RENEW_URL;
}

/**
 * Reminder lead time in whole days, clamped to 0-60 (invalid → default).
 * @param {*} value `oauth.qrole.expiryReminderDays`
 * @returns {number}
 */
export function normalizeReminderDays(value) {
    const days = toNumber(value);
    if (!Number.isFinite(days)) return DEFAULT_EXPIRY_REMINDER_DAYS;
    return Math.min(MAX_EXPIRY_REMINDER_DAYS, Math.max(0, Math.round(days)));
}

/**
 * Cleanup delay in whole days, clamped to 30-3650 (invalid → default).
 * @param {*} value `oauth.qrole.expiredCleanup.afterDays`
 * @returns {number}
 */
export function normalizeCleanupAfterDays(value) {
    const days = toNumber(value);
    if (!Number.isFinite(days)) return DEFAULT_CLEANUP_AFTER_DAYS;
    return Math.min(MAX_CLEANUP_AFTER_DAYS, Math.max(MIN_CLEANUP_AFTER_DAYS, Math.round(days)));
}

/**
 * Lifecycle settings from an `oauth.qrole` config object, with the code defaults filled in.
 * @param {*} raw `oauth.qrole` config
 * @returns {QroleLifecycleConfig}
 */
export function resolveQroleLifecycleConfig(raw) {
    const cfg = isPlainObject(raw) ? raw : {};
    const cleanup = isPlainObject(cfg.expiredCleanup) ? cfg.expiredCleanup : {};
    return {
        requireMembership: cfg.requireMembership !== false,
        backgroundReverify: cfg.backgroundReverify !== false,
        renewUrl: normalizeRenewUrl(cfg.renewUrl),
        expiryReminderDays: normalizeReminderDays(cfg.expiryReminderDays),
        expiredDataExport: cfg.expiredDataExport !== false,
        expiredCleanup: {
            enabled: cleanup.enabled === true,
            afterDays: normalizeCleanupAfterDays(cleanup.afterDays),
        },
        reverifyHours: getReverifyHours(cfg.reverifyHours),
    };
}

/**
 * The raw `oauth.qrole` config object ({} when missing or invalid).
 * @returns {object}
 */
export function getQroleConfig() {
    const raw = getStcConfig('oauth.qrole', {});
    return isPlainObject(raw) ? raw : {};
}

/**
 * Lifecycle settings of the current config.yaml (the single reader of the lifecycle keys).
 * @returns {QroleLifecycleConfig}
 */
export function getQroleLifecycleConfig() {
    return resolveQroleLifecycleConfig(getQroleConfig());
}

/**
 * Whether refresh tokens are kept and used (membership gate on and background re-verification on).
 * @param {QroleLifecycleConfig} lifecycle
 * @returns {boolean}
 */
export function isRefreshTokenFeatureOn(lifecycle) {
    return !!lifecycle && lifecycle.requireMembership && lifecycle.backgroundReverify;
}

/**
 * Whether metadata holds a refresh token that has not expired yet (it may still fail to decrypt).
 * @param {object|null|undefined} meta
 * @param {number} [now]
 * @returns {boolean}
 */
export function hasStoredRefreshToken(meta, now = Date.now()) {
    if (!meta || typeof meta.qroleRefreshToken !== 'string' || !meta.qroleRefreshToken) return false;
    const expiresAt = meta.qroleRefreshTokenExpiresAt;
    return isFiniteNumber(expiresAt) && expiresAt > now;
}

/**
 * Expiry (ms) to store for a refresh token: now + refresh_token_expires_in, 30 days when missing
 * or invalid, never more than 90 days.
 * @param {*} expiresIn `refresh_token_expires_in` (seconds)
 * @param {number} [now]
 * @returns {number}
 */
export function computeRefreshTokenExpiry(expiresIn, now = Date.now()) {
    const seconds = toNumber(expiresIn);
    const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : REFRESH_TOKEN_DEFAULT_TTL_MS;
    return now + Math.min(ttl, REFRESH_TOKEN_MAX_TTL_MS);
}

/**
 * Normalized tier (trimmed, lowercase) or null.
 * @param {*} value
 * @returns {string|null}
 */
export function normalizeTier(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * Whether a tier is in `oauth.qrole.allowedTiers`.
 * @param {*} tier
 * @param {object} cfg `oauth.qrole` config
 * @returns {boolean}
 */
export function isTierAllowed(tier, cfg) {
    const normalized = normalizeTier(tier);
    return !!normalized && normalizeAllowedTiers(cfg?.allowedTiers).includes(normalized);
}

/**
 * @typedef {Object} QroleSessionResult
 * @property {boolean} valid Whether the session may continue
 * @property {null|'membership_expired'|'not_member'|'membership_reverify'} reason Why it is invalid
 */

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
    if (isFiniteNumber(expiresAt) && expiresAt <= now) {
        return { valid: false, reason: 'membership_expired' };
    }

    if (!isTierAllowed(data.qroleTier, config)) {
        return { valid: false, reason: 'not_member' };
    }

    const reverifyHours = getReverifyHours(config.reverifyHours);
    if (reverifyHours > 0) {
        const windowMs = reverifyHours * 3600 * 1000 * (opts.isApi ? 2 : 1);
        const checkedAt = data.qroleCheckedAt;
        if (!isFiniteNumber(checkedAt) || now - checkedAt > windowMs) {
            return { valid: false, reason: 'membership_reverify' };
        }
    }

    return { valid: true, reason: null };
}

/**
 * @typedef {Object} QroleAccountState
 * @property {'active'|'expired'|'not_member'} state
 * @property {number|null} expiredSince expired: the membership expiry; not_member: the most recent
 *   denied QRole login, else when a background check first found no allowed tier (qroleDeniedAt),
 *   else the last check (qroleCheckedAt)
 */

/**
 * Membership state of a QRole-linked account from its stored snapshot.
 * @param {object|null|undefined} meta STC metadata
 * @param {object} cfg `oauth.qrole` config (allowedTiers)
 * @param {number} [now]
 * @returns {QroleAccountState}
 */
export function getQroleAccountState(meta, cfg, now = Date.now()) {
    const data = meta && typeof meta === 'object' ? meta : {};
    const expiresAt = toTimestamp(data.qroleMembershipExpiresAt);
    if (expiresAt !== null && expiresAt <= now) {
        return { state: 'expired', expiredSince: expiresAt };
    }
    if (!isTierAllowed(data.qroleTier, cfg)) {
        return { state: 'not_member', expiredSince: toTimestamp(data.qroleDeniedAt) ?? toTimestamp(data.qroleCheckedAt) };
    }
    return { state: 'active', expiredSince: null };
}

/**
 * Login-page / export reason code for an account state.
 * @param {'active'|'expired'|'not_member'} state
 * @returns {null|'membership_expired'|'not_member'}
 */
export function stateToReason(state) {
    if (state === 'expired') return 'membership_expired';
    if (state === 'not_member') return 'not_member';
    return null;
}

/**
 * When an account becomes eligible for automatic cleanup: the latest of the lapse date, the last
 * activity and the last login, plus `afterDays` days. Null when cleanup is disabled, the account is
 * active, or no reference date is known (such accounts are never cleaned automatically).
 * @param {object|null|undefined} meta STC metadata
 * @param {QroleAccountState} accountState
 * @param {{enabled: boolean, afterDays: number}} cleanup `expiredCleanup` settings
 * @returns {number|null}
 */
export function computeCleanupAt(meta, accountState, cleanup) {
    if (!cleanup?.enabled || !accountState || accountState.state === 'active') return null;
    const data = meta && typeof meta === 'object' ? meta : {};
    const references = [accountState.expiredSince, data.lastActiveAt, data.lastLoginAt]
        .filter(value => isFiniteNumber(value) && value > 0);
    if (!references.length) return null;
    return Math.max(...references) + normalizeCleanupAfterDays(cleanup.afterDays) * DAY_MS;
}

/**
 * Whether the cleanup job may delete accounts under these settings (cleanup on and the membership
 * gate on).
 * @param {QroleLifecycleConfig} lifecycle
 * @returns {boolean}
 */
export function isCleanupActive(lifecycle) {
    return !!lifecycle && lifecycle.requireMembership && lifecycle.expiredCleanup.enabled;
}

/**
 * @typedef {Object} CleanupEligibility
 * @property {QroleAccountState} accountState
 * @property {number|null} cleanupAt
 * @property {boolean} eligible Lapsed and the cleanup date has passed
 */

/**
 * Cleanup eligibility of an account from its snapshot (the cleanup switch is not checked here).
 * @param {object|null|undefined} meta STC metadata
 * @param {object} cfg `oauth.qrole` config (allowedTiers)
 * @param {QroleLifecycleConfig} lifecycle
 * @param {number} now
 * @returns {CleanupEligibility}
 */
export function getCleanupEligibility(meta, cfg, lifecycle, now) {
    const accountState = getQroleAccountState(meta, cfg, now);
    const cleanupAt = computeCleanupAt(meta, accountState, { enabled: true, afterDays: lifecycle.expiredCleanup.afterDays });
    return { accountState, cleanupAt, eligible: accountState.state !== 'active' && cleanupAt !== null && now >= cleanupAt };
}

/**
 * Final check of the cleanup job right before it deletes an account (run under the deletion lock,
 * with the settings and the account read again): cleanup switched off, account gone / no longer a
 * live QRole account (deleted, unlinked, made admin: `meta` null) or linked to another QRole user,
 * renewed, or not due any more (e.g. activity since) → the deletion is vetoed.
 * @param {Object} params
 * @param {object} params.cfg Current `oauth.qrole` config
 * @param {QroleLifecycleConfig} params.lifecycle Current lifecycle settings
 * @param {object|null} params.meta Current metadata of the live QRole account, null when there is none
 * @param {string} params.oauthUserId QRole user the job decided to delete
 * @param {number} params.now
 * @returns {{veto: null|'cleanup_disabled'|'gone'|'renewed'|'not_due', eligibility: CleanupEligibility|null}}
 */
export function checkCleanupStillDue({ cfg, lifecycle, meta, oauthUserId, now }) {
    if (!isCleanupActive(lifecycle)) return { veto: 'cleanup_disabled', eligibility: null };
    if (!meta || !meta.oauthUserId || String(meta.oauthUserId) !== String(oauthUserId)) return { veto: 'gone', eligibility: null };
    const eligibility = getCleanupEligibility(meta, cfg, lifecycle, now);
    if (!eligibility.eligible) return { veto: eligibility.accountState.state === 'active' ? 'renewed' : 'not_due', eligibility };
    return { veto: null, eligibility };
}

/**
 * Metadata patch recording a membership check result (login, denied login or re-verification).
 * - The tier / expiry snapshot and `qroleCheckedAt` are replaced.
 * - QRole reports a lapsed membership as tier `free` without an expiry; the last known (past)
 *   expiry is kept then, so the account stays "expired since <date>" instead of looking like it
 *   never had a membership (and its cleanup date does not move).
 * - `qroleDeniedAt`: cleared when allowed; set to now on every denied login (`denied`, so the
 *   cleanup date of a non-member counts from the latest attempt), otherwise only set when missing
 *   (first time a background check sees no valid membership). Non-null therefore also means "the
 *   last check found no valid membership".
 * @param {object|null|undefined} meta Current STC metadata
 * @param {{allowed: boolean, tier: string|null, expiresAt: number|null, tierName?: string|null}} membership
 * @param {number} now
 * @param {{denied?: boolean}} [opts]
 * @returns {object}
 */
export function buildMembershipSnapshot(meta, membership, now, opts = {}) {
    const data = meta && typeof meta === 'object' ? meta : {};
    /** @type {Record<string, *>} */
    const patch = {
        qroleTier: normalizeTier(membership?.tier),
        qroleMembershipExpiresAt: toTimestamp(membership?.expiresAt),
        qroleCheckedAt: now,
    };
    if (membership && membership.tierName !== undefined) {
        patch.qroleTierName = typeof membership.tierName === 'string' && membership.tierName ? membership.tierName : null;
    }
    if (membership?.allowed) {
        patch.qroleDeniedAt = null;
        return patch;
    }
    const previousExpiry = toTimestamp(data.qroleMembershipExpiresAt);
    if (patch.qroleMembershipExpiresAt === null && previousExpiry !== null && previousExpiry <= now) {
        patch.qroleMembershipExpiresAt = previousExpiry;
    }
    const previousDenied = toTimestamp(data.qroleDeniedAt);
    patch.qroleDeniedAt = opts.denied || previousDenied === null ? now : previousDenied;
    return patch;
}

/**
 * @typedef {Object} QroleVerification
 * @property {'ok'|'no_token'|'transient'|'definitive'} result
 * @property {string|null} reason Detail (membership code for ok, failure class otherwise)
 */

/**
 * @typedef {Object} VerificationPlan
 * @property {'ok'|'transient'|'definitive'} result
 * @property {string|null} reason ok: membership deny code (null = active); otherwise the failure class
 * @property {boolean} clearToken Delete the stored refresh token
 * @property {boolean} cooldown Pause automatic re-verification of the account
 * @property {object|null} patch Metadata update (ok only)
 * @property {{allowed: boolean, code: string|null, tier: string|null, expiresAt: number|null}|null} membership Fresh evaluation (ok only)
 */

/**
 * What to do with the result of a refresh-token round trip (see oauth-client refreshQroleIdentity):
 * - transient (network, timeout, 429, 5xx, unparsable, and invalid_client: a rejected client
 *   credential says nothing about the account) → keep the token, cool down;
 * - definitive (invalid_grant, malformed token response) → delete the token;
 * - the fresh identity must be the linked QRole user, otherwise → definitive (token deleted);
 * - membership claims missing (`membership_unknown`) → transient-like: keep the token, cool down;
 * - suspended QRole account → definitive;
 * - otherwise ok: the snapshot is updated (lapsed memberships included, the session then ends).
 * @param {{kind: 'ok'|'definitive'|'transient', reason: string|null, identityId?: string|null, claims?: object|null}} refreshed
 * @param {object} meta Current STC metadata of the account (oauthUserId, snapshot)
 * @param {object} cfg `oauth.qrole` config
 * @param {number} now
 * @returns {VerificationPlan}
 */
export function planVerificationOutcome(refreshed, meta, cfg, now) {
    /** @type {(result: VerificationPlan['result'], reason: string|null, clearToken: boolean, cooldown: boolean) => VerificationPlan} */
    const plan = (result, reason, clearToken, cooldown) => ({ result, reason, clearToken, cooldown, patch: null, membership: null });

    if (!refreshed || refreshed.kind === 'transient') return plan('transient', refreshed?.reason || 'unknown', false, true);
    if (refreshed.kind === 'definitive') return plan('definitive', refreshed.reason || 'unknown', true, false);
    if (!meta?.oauthUserId || refreshed.identityId !== String(meta.oauthUserId)) {
        return plan('definitive', 'identity_mismatch', true, false);
    }

    const membership = evaluateQroleMembership(refreshed.claims, cfg, now);
    if (membership.code === 'membership_unknown') return plan('transient', 'membership_unknown', false, true);
    if (membership.code === 'account_suspended') return plan('definitive', 'account_suspended', true, false);

    const snapshot = buildMembershipSnapshot(meta, { ...membership, tierName: getQroleTierName(refreshed.claims) }, now);
    return {
        result: 'ok',
        reason: membership.code,
        clearToken: false,
        cooldown: false,
        patch: { ...snapshot, qroleVerifiedVia: 'refresh' },
        membership: {
            allowed: membership.allowed,
            code: membership.code,
            tier: membership.tier,
            expiresAt: membership.expiresAt,
        },
    };
}

/**
 * @typedef {Object} QroleSessionDecision
 * @property {boolean} valid Whether the request may continue as the logged-in user
 * @property {null|'membership_expired'|'not_member'|'membership_reverify'} reason Invalid reason
 * @property {null|'ok'|'no_token'|'transient'|'definitive'|'cooldown'|'recent'} verification What
 *   the background re-verification did (null when it was not attempted; 'recent' = skipped because
 *   QRole reported the lapse moments ago)
 */

/**
 * Whether the last membership check (background re-verification or QRole login) found no valid
 * membership and happened less than LAPSE_RECHECK_PAUSE_MS ago. A snapshot that was valid when it
 * was checked and has merely run out since (e.g. renewed right before the expiry) does not count.
 * @param {object|null|undefined} meta STC metadata
 * @param {number} now
 * @returns {boolean}
 */
export function isLapseRecentlyConfirmed(meta, now) {
    const checkedAt = toTimestamp(meta?.qroleCheckedAt);
    if (toTimestamp(meta?.qroleDeniedAt) === null || checkedAt === null) return false;
    const age = now - checkedAt;
    return age >= 0 && age < LAPSE_RECHECK_PAUSE_MS;
}

/**
 * Guard decision for a QRole session (dependencies injected so the table can be unit tested).
 * 1. Snapshot valid → continue.
 * 2. No background re-verification possible (feature off / no usable token) → today's rules.
 * 3. QRole reported the lapse moments ago (isLapseRecentlyConfirmed) → deny without asking again.
 * 4. Re-verify (unless cooling down after a transient failure): ok → decide on the fresh snapshot;
 *    definitive / no_token → deny.
 * 5. Transient failure or cooldown: a snapshot that is only due for re-verification is honored
 *    until twice the window has passed since the last check (pages and API alike); an expired or
 *    non-member snapshot is denied (fail closed for paid access).
 * @param {Object} params
 * @param {object|null} params.meta Live STC metadata of the account
 * @param {object} params.cfg `oauth.qrole` config
 * @param {number} params.now
 * @param {boolean} params.isApi
 * @param {boolean} params.verifyAvailable Feature on and a usable (unexpired) refresh token stored
 * @param {boolean} params.inCooldown A transient failure happened recently
 * @param {() => Promise<QroleVerification>} params.verify Re-verify the membership now
 * @param {() => object|null} params.reloadMeta Live metadata after the re-verification
 * @param {() => number} [params.clock] Current time after the re-verification
 * @returns {Promise<QroleSessionDecision>}
 */
export async function decideQroleSession({ meta, cfg, now, isApi, verifyAvailable, inCooldown, verify, reloadMeta, clock = Date.now }) {
    const initial = evaluateQroleSession(meta, cfg, now, { isApi });
    if (initial.valid) return { ...initial, verification: null };
    if (!verifyAvailable) return { ...initial, verification: null };
    if (initial.reason !== 'membership_reverify' && isLapseRecentlyConfirmed(meta, now)) {
        return { valid: false, reason: initial.reason, verification: 'recent' };
    }

    /** @type {QroleSessionDecision['verification']} */
    let verification = 'cooldown';
    if (!inCooldown) {
        const outcome = await verify();
        verification = outcome?.result || 'transient';
        if (verification === 'ok') {
            const fresh = evaluateQroleSession(reloadMeta(), cfg, clock(), { isApi });
            return { ...fresh, verification };
        }
        if (verification !== 'transient') {
            return { valid: false, reason: initial.reason, verification };
        }
    }

    if (initial.reason === 'membership_reverify') {
        const hours = getReverifyHours(cfg?.reverifyHours);
        const checkedAt = toTimestamp(meta?.qroleCheckedAt);
        if (hours > 0 && checkedAt !== null && now - checkedAt <= 2 * hours * 3600 * 1000) {
            return { valid: true, reason: null, verification };
        }
    }
    return { valid: false, reason: initial.reason, verification };
}
