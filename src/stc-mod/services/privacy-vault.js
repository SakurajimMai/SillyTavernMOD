/**
 * SillyTavernchat Module - per-user privacy vault.
 * The vault keeps API key values encrypted at rest while leaving SillyTavern's
 * internal secrets, such as csrfSecret, readable for normal login flow.
 *
 * Vault records (`stc-mod/privacy-vaults/vault_<id>.json`, salt + verifier) are read with error
 * classification (services/json-store.js): only a missing record means "vault not enabled".
 * A record that cannot be read (EIO, lost mount, ...) throws StoreUnavailableError (HTTP 503) and
 * an unparseable one VaultRecordCorruptError (a copy is kept as `.corrupt-<ts>`); in both cases
 * status / unlock / enable / saving an API key fail instead of treating the vault as disabled, and
 * enabling never overwrites the existing record. Resetting the vault is the way out of a corrupt record.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getStcConfig, getStcDataDir } from '../config.js';
import {
    StoreConflictError,
    StoreUnavailableError,
    assertDataRootAvailable,
    isPlainObject,
    readJsonFile,
    writeJsonFileAtomic,
} from './json-store.js';

export const VAULT_VALUE_MARKER = '__stc_vault_value';

// Versioning for future algorithm rotation
const VAULT_RECORD_VERSION = 1;
const VERIFIER_PLAINTEXT = 'stc-secrets-vault-verifier:v1';
const DEFAULT_UNLOCK_TTL_MINUTES = 1440;

// In-memory cache of unlocked keys (never written to disk, lost on restart)
// Map<VaultId, { key: Buffer, expiresAt: number }>
const unlockedVaults = new Map();

export class VaultLockedError extends Error {
    constructor(message = 'API key vault is locked or not enabled.') {
        super(message);
        this.name = 'VaultLockedError';
    }
}

export class VaultRequiredError extends Error {
    constructor(message = 'API key vault setup is required.') {
        super(message);
        this.name = 'VaultRequiredError';
    }
}

/**
 * The vault record exists but cannot be parsed: the vault is neither "not enabled" nor usable.
 */
export class VaultRecordCorruptError extends Error {
    constructor(message = 'API 密钥保险箱记录已损坏，无法读取。请联系管理员，或重置保险箱（已加密的密钥将被删除）。') {
        super(message);
        this.name = 'VaultRecordCorruptError';
        this.code = 'VAULT_RECORD_CORRUPT';
    }
}

/**
 * Gets the base directory for all vault data (not created; see ensureVaultDirectory).
 * @returns {string}
 */
function getVaultDirectory() {
    return path.join(getStcDataDir(), 'privacy-vaults');
}

/**
 * Create the vault directory before a record is written.
 */
function ensureVaultDirectory() {
    const dir = getVaultDirectory();
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
        throw new StoreUnavailableError(`vault directory could not be created (${error?.code || error?.message})`, { cause: error });
    }
}

/**
 * Generates a consistent, safe identifier for a user's vault based on their directory.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {string}
 */
function getVaultId(directories) {
    const userDir = directories.user;
    const hash = crypto.createHash('sha256').update(userDir).digest('hex');
    return `vault_${hash.substring(0, 16)}`;
}

/**
 * Gets the path to a user's vault record file.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {string}
 */
function getVaultPath(directories) {
    return path.join(getVaultDirectory(), `${getVaultId(directories)}.json`);
}

/**
 * Key used for the in-memory cache.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {string}
 */
function getCacheKey(directories) {
    return getVaultId(directories);
}

/**
 * Gets TTL in milliseconds from config.
 * @returns {number}
 */
function getUnlockTtlMs() {
    const ttlMinutes = getStcConfig('privacy.secretsVault.unlockTtlMinutes', DEFAULT_UNLOCK_TTL_MINUTES);
    return ttlMinutes * 60 * 1000;
}

/**
 * Derives a strong encryption key from a user passphrase.
 * @param {string} passphrase
 * @param {string} salt - Base64 encoded salt
 * @returns {Buffer} - 32 byte key for AES-256
 */
function deriveKey(passphrase, salt) {
    const saltBuffer = Buffer.from(salt, 'base64');
    // scrypt parameters: N=16384, r=8, p=1, length=32
    return crypto.scryptSync(passphrase, saltBuffer, 32, { N: 16384, r: 8, p: 1 });
}

/**
 * Encrypts a string value using AES-256-GCM.
 * @param {Buffer} key
 * @param {string} value
 * @returns {string} Base64 encoded payload: "version:iv:authTag:encryptedData"
 */
function encryptWithKey(key, value) {
    const iv = crypto.randomBytes(12); // GCM standard IV length
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(value, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');

    return `${VAULT_RECORD_VERSION}:${iv.toString('base64')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a payload created by encryptWithKey.
 * @param {Buffer} key
 * @param {string} encryptedValue - Payload returned by encryptWithKey
 * @returns {string} Decrypted plaintext
 * @throws {Error} If decryption fails (wrong key, tampered data)
 */
function decryptWithKey(key, encryptedValue) {
    const parts = encryptedValue.split(':');
    if (parts.length !== 4) {
        throw new Error('Invalid encrypted payload format');
    }

    const [version, iv64, authTag64, data64] = parts;

    if (parseInt(version, 10) !== VAULT_RECORD_VERSION) {
        throw new Error(`Unsupported vault record version: ${version}`);
    }

    const iv = Buffer.from(iv64, 'base64');
    const authTag = Buffer.from(authTag64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(data64, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

/**
 * Whether a parsed vault record has the fields the vault needs.
 * @param {any} record
 * @returns {boolean}
 */
function isVaultRecord(record) {
    return isPlainObject(record) && typeof record.salt === 'string' && typeof record.verifier === 'string';
}

/**
 * Reads a user's vault record from disk.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {Object|null} null only when the vault is not enabled (no record file)
 * @throws {StoreUnavailableError} The record cannot be read right now
 * @throws {VaultRecordCorruptError} The record exists but is unusable
 */
function readVaultRecord(directories) {
    const recordPath = getVaultPath(directories);
    const result = readJsonFile(recordPath, { validate: isVaultRecord, backup: false, label: 'Privacy vault' });
    if (result.status === 'missing') return null;
    if (result.status === 'ok' || result.status === 'recovered') return result.data;
    console.error(`[STC-MOD] Vault: record of ${directories.user} is corrupt (${result.reason}); status, unlock and enable are refused until it is repaired or the vault is reset`);
    throw new VaultRecordCorruptError();
}

/**
 * Writes a new vault record (never replaces an existing file).
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {Object} record
 * @returns {boolean} false when a record appeared meanwhile (not written)
 */
function writeNewVaultRecord(directories, record) {
    ensureVaultDirectory();
    try {
        writeJsonFileAtomic(getVaultPath(directories), record, { expectMissing: true });
        return true;
    } catch (error) {
        if (error instanceof StoreConflictError) return false;
        throw error;
    }
}

/**
 * Caches the derived key in memory for future fast access.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {Buffer} key
 */
function cacheUnlockedKey(directories, key) {
    const cacheKey = getCacheKey(directories);
    const ttlMs = getUnlockTtlMs();

    unlockedVaults.set(cacheKey, {
        key: key,
        expiresAt: Date.now() + ttlMs,
    });

    // Automatically clear from cache when TTL expires
    // (getUnlockedKey also checks expiresAt; the timer never keeps the process alive)
    setTimeout(() => {
        const current = unlockedVaults.get(cacheKey);
        if (current && current.expiresAt <= Date.now()) {
            unlockedVaults.delete(cacheKey);
            console.log(`[STC-MOD] Vault: Cached key expired and locked for user: ${directories.user}`);
        }
    }, ttlMs).unref();
}

/**
 * Retrieves the cached key if it exists and hasn't expired.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {Buffer|null}
 */
function getUnlockedKey(directories) {
    const cacheKey = getCacheKey(directories);
    const cached = unlockedVaults.get(cacheKey);

    if (!cached) return null;

    if (cached.expiresAt <= Date.now()) {
        unlockedVaults.delete(cacheKey);
        return null;
    }

    // Slide expiration window on access
    cached.expiresAt = Date.now() + getUnlockTtlMs();
    return cached.key;
}

/**
 * Creates a new vault record and derives the initial key.
 * @param {string} passphrase
 * @returns {{ record: Object, key: Buffer }}
 */
function createVaultRecord(passphrase) {
    const salt = crypto.randomBytes(16).toString('base64');
    const key = deriveKey(passphrase, salt);

    const record = {
        version: VAULT_RECORD_VERSION,
        salt: salt,
        createdAt: Date.now(),
        // Encrypt a known string to verify passphrase later without trying to decrypt actual data
        verifier: encryptWithKey(key, VERIFIER_PLAINTEXT),
    };

    return { record, key };
}

/**
 * Verifies a passphrase against a vault record.
 * @param {Object} record
 * @param {string} passphrase
 * @returns {Buffer} The derived key if successful
 * @throws {Error} If passphrase is wrong
 */
function verifyPassphrase(record, passphrase) {
    const key = deriveKey(passphrase, record.salt);
    try {
        const plaintext = decryptWithKey(key, record.verifier);
        if (plaintext !== VERIFIER_PLAINTEXT) {
            throw new Error('Verifier mismatch (should not happen if auth tag matches)');
        }
        return key;
    } catch (err) {
        throw new Error('Invalid passphrase');
    }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Determines if a given secret key should be protected by the vault.
 * Currently, anything starting with 'api_key_' is protected, plus specific others.
 * System secrets like 'csrfSecret' or 'password' must NOT be protected.
 * @param {string} key - The secret key name from secrets.js
 * @returns {boolean}
 */
export function isVaultProtectedKey(key) {
    if (key.startsWith('api_key_')) return true;
    if (key === 'volcengine_app_id' || key === 'volcengine_access_key') return true;
    if (key === 'discord_token' || key === 'poe_token') return true;

    return false;
}

/**
 * Checks if the global configuration requires vaults for API keys.
 * @returns {boolean}
 */
export function isVaultRequiredForApiKeys() {
    return getStcConfig('privacy.secretsVault.requireForApiKeys', false);
}

/**
 * Checks if a value appears to be encrypted by the vault.
 * @param {string|Object} value
 * @returns {boolean}
 */
export function isEncryptedVaultValue(value) {
    if (!value || typeof value !== 'object') return false;
    return value.type === VAULT_VALUE_MARKER && typeof value.data === 'string';
}

/**
 * Gets the current status of the user's vault.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {Object} { enabled: boolean, unlocked: boolean, requireForApiKeys: boolean, expiresAt: number|null }
 */
export function getVaultStatus(directories) {
    const record = readVaultRecord(directories);
    const cached = unlockedVaults.get(getCacheKey(directories));

    const isUnlocked = !!(cached && cached.expiresAt > Date.now());

    return {
        enabled: !!record,
        unlocked: isUnlocked,
        requireForApiKeys: isVaultRequiredForApiKeys(),
        expiresAt: isUnlocked ? cached.expiresAt : null,
    };
}

/**
 * Enables the vault for a user, creating the record and unlocking it.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} passphrase
 * @returns {boolean} true if newly enabled, false if already enabled
 * @throws {StoreUnavailableError|VaultRecordCorruptError} An existing record is never overwritten
 */
export function initializeVault(directories, passphrase) {
    if (readVaultRecord(directories)) {
        return false; // Already enabled
    }

    const { record, key } = createVaultRecord(passphrase);
    if (!writeNewVaultRecord(directories, record)) {
        return false; // Enabled concurrently: that record is kept
    }
    cacheUnlockedKey(directories, key);

    console.log(`[STC-MOD] Vault: Enabled for user ${directories.user}`);
    return true;
}

/**
 * Unlocks an existing vault, caching the key in memory.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} passphrase
 * @returns {boolean} true if successfully unlocked
 * @throws {Error} if passphrase is wrong or vault not enabled
 */
export function unlockVault(directories, passphrase) {
    const record = readVaultRecord(directories);
    if (!record) {
        throw new Error('Vault is not enabled for this user.');
    }

    const key = verifyPassphrase(record, passphrase);
    cacheUnlockedKey(directories, key);
    return true;
}

/**
 * Immediately locks the vault by clearing it from memory.
 * @param {import('../../users.js').UserDirectoryList} directories
 */
export function lockVault(directories) {
    unlockedVaults.delete(getCacheKey(directories));
}

/**
 * Encrypts a plaintext secret value if the vault is unlocked.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} value - Plaintext value to encrypt
 * @returns {Object} Encrypted structure to be stored in secrets.js
 * @throws {VaultLockedError} if vault is locked
 */
export function encryptSecretValue(directories, value) {
    // If it's already an encrypted marker object, return as is to prevent double encryption
    if (isEncryptedVaultValue(value)) {
        return value;
    }

    const key = getUnlockedKey(directories);
    if (!key) {
        throw new VaultLockedError();
    }

    const encryptedData = encryptWithKey(key, value);

    return {
        type: VAULT_VALUE_MARKER,
        data: encryptedData,
    };
}

/**
 * Decrypts a vault-encrypted secret value if the vault is unlocked.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {Object} encryptedStructure - The structure created by encryptSecretValue
 * @returns {string} Decrypted plaintext value
 * @throws {VaultLockedError} if vault is locked
 * @throws {Error} if decryption fails due to corruption/tampering
 */
export function decryptSecretValue(directories, encryptedStructure) {
    if (!isEncryptedVaultValue(encryptedStructure)) {
        // Not an encrypted value, return as is (could be a legacy plaintext string or empty)
        // If it's an object but not a vault marker, returning it as-is is safer than crashing
        return typeof encryptedStructure === 'string' ? encryptedStructure : '';
    }

    const key = getUnlockedKey(directories);
    if (!key) {
        throw new VaultLockedError();
    }

    return decryptWithKey(key, encryptedStructure.data);
}


/**
 * Completely resets the user's vault:
 * - deletes the encrypted-key cache from memory,
 * - removes the on-disk vault record (salt + verifier).
 *
 * Does NOT touch secrets.json by itself. The caller (SecretManager) is
 * responsible for wiping the matching encrypted entries from secrets.json
 * since, without the passphrase, they can no longer be decrypted.
 *
 * Safe to call when the vault is not enabled (returns { existed: false }).
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {{ existed: boolean }}
 */
export function resetVault(directories) {
    // Always clear in-memory key first
    lockVault(directories);

    const recordPath = getVaultPath(directories);
    // A lost data root must not look like "no record" (the caller then wipes the encrypted keys)
    assertDataRootAvailable();
    try {
        fs.unlinkSync(recordPath);
        console.log(`[STC-MOD] Vault: Record removed for user ${directories.user}`);
        return { existed: true };
    } catch (err) {
        if (err?.code === 'ENOENT') {
            assertDataRootAvailable();
            return { existed: false };
        }
        console.error(`[STC-MOD] Vault: Failed to remove record for ${directories.user}:`, err);
        throw new StoreUnavailableError(`vault record could not be removed (${err?.code || err?.message})`, { cause: err });
    }
}
