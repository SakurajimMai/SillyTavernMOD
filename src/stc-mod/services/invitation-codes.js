/**
 * SillyTavernchat Module - Invitation Codes Service
 * Uses file-based storage in stc-mod data directory (`invitation-codes.json`, a JSON array).
 * Reads never fall back to an empty list on storage errors: StoreUnavailableError (HTTP 503) is
 * thrown instead, see services/json-store.js. A missing file is an empty list; an unparseable one is
 * recovered from its `.bak` or kept as `.corrupt-<ts>`.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { getStcConfig, getStcDataDir } from '../config.js';
import { getUserMeta, setUserMeta } from '../user-metadata.js';
import { createJsonStore } from './json-store.js';

const CODES_FILE = 'invitation-codes.json';

const codesStore = createJsonStore({
    label: 'Invitation codes',
    file: () => path.join(getStcDataDir(), CODES_FILE),
    validate: Array.isArray,
    empty: () => [],
});

/**
 * @returns {object[]}
 * @throws {import('./json-store.js').StoreUnavailableError}
 */
function loadCodes() {
    return codesStore.read();
}

function generateCode() {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

const DURATION_MAP = {
    '1day': 1, '1week': 7, '1month': 30, '1quarter': 90,
    '6months': 180, '1year': 365, 'permanent': null,
};

function getDurationDays(type) {
    return DURATION_MAP[type] ?? null;
}

/**
 * Calculate expiration timestamp from a duration type
 * @param {string} durationType
 * @returns {number} 0 for permanent, timestamp for others
 */
export function calculateExpiration(durationType) {
    const days = getDurationDays(durationType);
    if (days === null) return 0;
    return Date.now() + days * 24 * 60 * 60 * 1000;
}

/**
 * Calculate duration in milliseconds from a duration type
 * @param {string} durationType
 * @returns {number|null} null for permanent, milliseconds for others
 */
function getDurationMs(durationType) {
    const days = getDurationDays(durationType);
    if (days === null) return null;
    return days * 24 * 60 * 60 * 1000;
}

export function isEnabled() {
    return !!getStcConfig('enableInvitationCodes', false);
}

export function createInvitationCode(createdBy, durationType = 'permanent') {
    const code = generateCode();
    const invitation = {
        code,
        createdBy,
        createdAt: Date.now(),
        used: false,
        usedBy: null,
        usedAt: null,
        durationType: durationType || 'permanent',
        durationDays: getDurationDays(durationType),
        userExpiresAt: null,
    };
    codesStore.update((codes) => {
        codes.push(invitation);
    });
    console.log(`[STC-MOD] Invitation code created: ${code} by ${createdBy}, duration: ${durationType}`);
    return invitation;
}

export function validateInvitationCode(code) {
    if (!isEnabled()) return { valid: true };
    if (!code || typeof code !== 'string') return { valid: false, reason: '邀请码格式无效' };

    const codes = loadCodes();
    const invitation = codes.find(c => c.code === code.toUpperCase());
    if (!invitation) return { valid: false, reason: '邀请码不存在' };
    if (invitation.used) return { valid: false, reason: '邀请码已被使用' };
    return { valid: true, invitation };
}

/**
 * New `expiresAt` of an account that redeems a code of the given duration (same rules as
 * extendExpiration: extends a running expiry, starts from now otherwise; permanent = 0).
 * An account without metadata only gets a value for permanent codes (0).
 * @param {object|null} meta Current metadata of the account
 * @param {string} durationType
 * @param {number} now
 * @returns {number}
 */
function computeUserExpiry(meta, durationType, now) {
    const durationMs = getDurationMs(durationType);
    if (durationMs === null) return 0;
    if (!meta) return 0;
    const currentExpiry = meta.expiresAt ?? now;
    const base = (currentExpiry !== 0 && currentExpiry > now) ? currentExpiry : now;
    return base + durationMs;
}

/**
 * Redeem an invitation code for an account: the code is marked used first, then the account's
 * expiry is extended and saved at once. Both stores are checked before anything changes
 * (StoreUnavailableError when one cannot be read), so an outage that is already there consumes
 * nothing. An outage that starts between the two writes leaves the new expiry pending in memory
 * (retried): an error naming the account and the code is logged and the result has
 * `persisted: false`; if the process stops before the retry succeeds, the code is used up without
 * the extension on disk.
 * @param {string} code
 * @param {string} usedBy Account handle
 * @returns {{success: boolean, reason?: string, invitation?: object, expiresAt?: number, persisted?: false}}
 */
export function useInvitationCode(code, usedBy) {
    if (!isEnabled()) return { success: true };
    if (!code || typeof code !== 'string') return { success: false, reason: '邀请码格式无效' };

    const upperCode = code.toUpperCase();
    // Throws while the metadata store is unavailable (nothing consumed yet)
    const meta = getUserMeta(usedBy);
    const now = Date.now();

    const outcome = codesStore.update((codes) => {
        const idx = codes.findIndex(c => c.code === upperCode);
        if (idx === -1) return { success: false, reason: '邀请码不存在' };
        const invitation = codes[idx];
        if (invitation.used) return { success: false, reason: '邀请码已被使用' };
        const userExpiresAt = computeUserExpiry(meta, invitation.durationType, now);
        codes[idx] = {
            ...invitation,
            used: true,
            usedBy,
            usedAt: now,
            userExpiresAt,
        };
        return { success: true, invitation: codes[idx], expiresAt: userExpiresAt };
    });
    if (!outcome.success) return outcome;

    // Permanent codes always set expiresAt = 0; time-limited ones only extend existing metadata
    if (getDurationMs(outcome.invitation.durationType) === null || meta) {
        const persisted = setUserMeta(usedBy, { expiresAt: outcome.expiresAt }, { immediate: true });
        if (!persisted) {
            // The code is used up on disk, the new expiry only in memory (retried): tell the admin
            const expiry = outcome.expiresAt ? new Date(outcome.expiresAt).toISOString() : 'permanent';
            console.error(`[STC-MOD] Invitation code ${upperCode} was used by "${usedBy}", but the new expiry (${expiry}) could not be saved yet; it stays pending and is retried. If SillyTavern stops before it is saved, set the expiry of "${usedBy}" by hand.`);
            outcome.persisted = false;
        }
    }

    console.log(`[STC-MOD] Invitation code used: ${upperCode} by ${usedBy}`);
    return outcome;
}

export function getAllInvitationCodes() {
    if (!isEnabled()) return [];
    return loadCodes()
        .filter(c => c.code && typeof c.code === 'string')
        .sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteInvitationCode(code) {
    const upperCode = String(code).toUpperCase();
    return codesStore.update((codes) => {
        const idx = codes.findIndex(c => c.code === upperCode);
        if (idx === -1) return false;
        codes.splice(idx, 1);
        return true;
    });
}

export function getPurchaseLink() {
    return getStcConfig('purchaseLink', '');
}
