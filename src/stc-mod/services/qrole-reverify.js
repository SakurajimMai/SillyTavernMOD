/**
 * SillyTavernchat Module - QRole background membership re-verification
 *
 * At QRole login the refresh token is kept (encrypted, see qrole-token-crypto.js) on the account's
 * metadata. When the stored membership snapshot runs out (expiry passed, tier no longer allowed or
 * the re-verification window elapsed), the membership is re-checked with QRole directly: refresh
 * grant → userinfo → the same membership evaluation as the login. Renewed members therefore keep
 * their session without logging in again.
 *
 * Outcomes: `ok` (snapshot updated), `no_token` (nothing usable stored), `definitive` (QRole no
 * longer accepts the token, identity mismatch or suspended account: the token is deleted) and
 * `transient` (network, timeout, 429, 5xx, unknown claims, and QRole rejecting this site's client
 * credentials (`invalid_client`): the token is kept and the account cools down for 5 minutes).
 * Calls per account are single-flight. Nothing here throws, and tokens are never logged.
 */
import storage from 'node-persist';
import { toKey } from '../../users.js';
import { getUserMeta, setUserMeta, unsetUserMetaFields } from '../user-metadata.js';
import { isMetaForRecord } from './account-security.js';
import { describeClaimKeys } from './qrole-membership.js';
import { configString, refreshQroleIdentity } from './oauth-client.js';
import { openRefreshToken, sealRefreshToken } from './qrole-token-crypto.js';
import {
    REFRESH_TOKEN_META_KEYS,
    computeRefreshTokenExpiry,
    getQroleConfig,
    hasStoredRefreshToken,
    isRefreshTokenFeatureOn,
    planVerificationOutcome,
    resolveQroleLifecycleConfig,
} from './qrole-lifecycle.js';

/** Hard limit for the refresh grant + userinfo round trip. */
export const VERIFY_TIMEOUT_MS = 8 * 1000;
/** Pause after a transient failure before the next automatic attempt for the same account. */
export const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;

/** @type {Map<string, Promise<QroleVerifyResult>>} */
const inflight = new Map();
/** @type {Map<string, number>} handle -> cooldown end (ms) */
const cooldowns = new Map();
// Last warning about rejected client credentials (one warning per cooldown period, not per account)
let clientRejectedWarnedAt = 0;

/**
 * @typedef {Object} QroleVerifyResult
 * @property {'ok'|'no_token'|'transient'|'definitive'} result
 * @property {string|null} reason ok: membership deny code (null = active); otherwise the failure class
 * @property {{allowed: boolean, code: string|null, tier: string|null, expiresAt: number|null}|null} membership
 *   Fresh membership evaluation (ok only)
 */

/**
 * @param {QroleVerifyResult['result']} result
 * @param {string|null} reason
 * @param {QroleVerifyResult['membership']} [membership]
 * @returns {QroleVerifyResult}
 */
function outcome(result, reason, membership = null) {
    return { result, reason, membership };
}

/**
 * Whether automatic re-verification of an account is paused after a transient failure.
 * @param {string} handle
 * @param {number} [now]
 * @returns {boolean}
 */
export function isVerificationCoolingDown(handle, now = Date.now()) {
    const until = cooldowns.get(handle);
    if (until === undefined) return false;
    if (until > now) return true;
    cooldowns.delete(handle);
    return false;
}

/**
 * The live QRole-linked, non-admin account of a handle (official record + metadata that belongs
 * to it), or null.
 * @param {string} handle
 * @returns {Promise<{handle: string, record: object, meta: object}|null>}
 */
export async function loadLiveQroleAccount(handle) {
    if (typeof handle !== 'string' || !handle) return null;
    const record = await storage.getItem(toKey(handle));
    if (!record || record.admin) return null;
    const meta = getUserMeta(handle);
    if (!meta || !isMetaForRecord(meta, record)) return null;
    if (meta.oauthProvider !== 'qrole' || !meta.oauthUserId) return null;
    return { handle, record, meta };
}

/**
 * Remove the stored refresh token of an account (no-op when there is none).
 * @param {string} handle
 * @returns {boolean} Whether a token was removed
 */
export function clearQroleRefreshToken(handle) {
    return unsetUserMetaFields(handle, REFRESH_TOKEN_META_KEYS, { immediate: true });
}

/**
 * Apply the refresh token rules after a QRole login (or an export-only denial) of a linked account:
 * with the feature on, store the new refresh token encrypted (an existing one is kept when QRole
 * sent none); with the feature off, remove any stored token. Never throws.
 * @param {string} handle Account handle
 * @param {{refreshToken?: string|null, refreshTokenExpiresIn?: *}|null} tokens Token response data
 * @param {import('./qrole-lifecycle.js').QroleLifecycleConfig} lifecycle
 * @param {number} [now]
 */
export function syncQroleRefreshToken(handle, tokens, lifecycle, now = Date.now()) {
    try {
        if (!isRefreshTokenFeatureOn(lifecycle)) {
            clearQroleRefreshToken(handle);
            return;
        }
        if (!tokens?.refreshToken) return;
        const envelope = sealRefreshToken(tokens.refreshToken, handle);
        if (!envelope) return;
        setUserMeta(handle, {
            qroleRefreshToken: envelope,
            qroleRefreshTokenExpiresAt: computeRefreshTokenExpiry(tokens.refreshTokenExpiresIn, now),
        });
    } catch (error) {
        console.error('[STC-MOD] Failed to store the QRole refresh token for', handle, error?.message);
    }
}

/**
 * Start a cooldown and log the transient failure (once per cooldown, no secrets).
 * @param {string} handle
 * @param {string} reason
 * @param {string} trigger
 */
function coolDown(handle, reason, trigger) {
    cooldowns.set(handle, Date.now() + TRANSIENT_COOLDOWN_MS);
    console.warn(`[STC-MOD] QRole membership re-verification for ${handle} failed temporarily (${reason}, trigger: ${trigger}); retrying in ${TRANSIENT_COOLDOWN_MS / 60000} min at the earliest`);
}

/**
 * Tell the admin once per cooldown period that QRole rejects this site's client credentials: every
 * account's re-verification fails the same way until config.yaml is fixed.
 */
function warnClientRejected() {
    const now = Date.now();
    const elapsed = now - clientRejectedWarnedAt;
    if (clientRejectedWarnedAt && elapsed >= 0 && elapsed < TRANSIENT_COOLDOWN_MS) return;
    clientRejectedWarnedAt = now;
    console.warn('[STC-MOD] QRole rejected this site\'s client credentials (invalid_client) during membership re-verification. Check oauth.qrole.clientId / clientSecret / tokenAuthMethod and that the client is still active at QRole. Stored refresh tokens are kept; until this is fixed QRole is treated as unavailable (no automatic deletions on this basis).');
}

/**
 * The actual verification (see verifyQroleMembership).
 * @param {string} handle
 * @param {{reason?: string, ignoreCooldown?: boolean}} opts
 * @returns {Promise<QroleVerifyResult>}
 */
async function runVerification(handle, opts) {
    const trigger = typeof opts.reason === 'string' && opts.reason ? opts.reason : 'manual';
    const cfg = getQroleConfig();
    const lifecycle = resolveQroleLifecycleConfig(cfg);
    if (!isRefreshTokenFeatureOn(lifecycle)) return outcome('no_token', 'disabled');

    const account = await loadLiveQroleAccount(handle);
    if (!account) return outcome('no_token', 'no_account');

    const now = Date.now();
    if (!hasStoredRefreshToken(account.meta, now)) {
        // An expired token is useless; drop it so it is not reported as present
        if (account.meta.qroleRefreshToken) clearQroleRefreshToken(handle);
        return outcome('no_token', 'no_token');
    }

    if (!opts.ignoreCooldown && isVerificationCoolingDown(handle, now)) {
        return outcome('transient', 'cooldown');
    }

    if (!cfg.enabled || !configString(cfg.clientId)) {
        // QRole login switched off or not configured: do not call QRole in the background
        coolDown(handle, 'provider_unavailable', trigger);
        return outcome('transient', 'provider_unavailable');
    }

    const opened = openRefreshToken(account.meta.qroleRefreshToken, handle);
    if (!opened.ok) {
        if (opened.reason === 'no_key') return outcome('no_token', 'key_unavailable');
        // Written with another key (key file replaced) or tampered with
        clearQroleRefreshToken(handle);
        console.warn(`[STC-MOD] Stored QRole refresh token of ${handle} could not be decrypted and was removed`);
        return outcome('no_token', 'undecryptable');
    }

    const startToken = account.meta.qroleRefreshToken;
    const startCheckedAt = account.meta.qroleCheckedAt;
    const refreshed = await refreshQroleIdentity(cfg, opened.token, { timeoutMs: VERIFY_TIMEOUT_MS });

    // The account may have changed while QRole was being asked (deleted, unlinked, re-linked)
    const current = await loadLiveQroleAccount(handle);
    if (!current || String(current.meta.oauthUserId) !== String(account.meta.oauthUserId)) {
        return outcome('no_token', 'no_account');
    }
    // A login (or another check) stored a newer token or snapshot meanwhile: this result is older,
    // so neither remove that token nor overwrite that snapshot. Callers re-read the account on 'ok'.
    if (current.meta.qroleRefreshToken !== startToken || current.meta.qroleCheckedAt !== startCheckedAt) {
        return outcome('ok', 'superseded');
    }

    const plan = planVerificationOutcome(refreshed, current.meta, cfg, Date.now());
    if (plan.clearToken) clearQroleRefreshToken(handle);
    if (plan.cooldown) {
        if (plan.reason === 'membership_unknown') {
            console.warn(`[STC-MOD] QRole membership could not be determined during re-verification; check oauth.qrole.tierClaims/expiryClaims. Userinfo claim keys: ${describeClaimKeys(refreshed.claims)}`);
        } else if (plan.reason === 'invalid_client') {
            warnClientRejected();
        }
        coolDown(handle, plan.reason || 'unknown', trigger);
        return outcome('transient', plan.reason);
    }
    if (plan.result === 'definitive') {
        console.info(`[STC-MOD] QRole refresh token of ${handle} can no longer be used (${plan.reason}); token removed`);
        return outcome('definitive', plan.reason);
    }

    setUserMeta(handle, plan.patch);
    cooldowns.delete(handle);
    console.info(`[STC-MOD] QRole membership of ${handle} re-verified in the background (${trigger}): ${plan.membership?.allowed ? 'active' : plan.reason}`);
    return outcome('ok', plan.reason, plan.membership);
}

/**
 * Re-verify the QRole membership of an account with its stored refresh token.
 * Concurrent callers for the same account share one run. Never throws.
 * @param {string} handle Account handle
 * @param {{reason?: string, ignoreCooldown?: boolean}} [opts] reason: trigger for the logs
 *   ('session', 'user', 'admin', 'cleanup'); ignoreCooldown: explicit user/admin requests
 * @returns {Promise<QroleVerifyResult>}
 */
export function verifyQroleMembership(handle, opts = {}) {
    const key = typeof handle === 'string' ? handle : '';
    if (!key) return Promise.resolve(outcome('no_token', 'no_account'));
    const running = inflight.get(key);
    if (running) return running;

    const promise = runVerification(key, opts)
        .catch((error) => {
            console.error(`[STC-MOD] QRole membership re-verification error for ${key}:`, error?.message || error);
            return outcome('transient', 'error');
        })
        .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
}
