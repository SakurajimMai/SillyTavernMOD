/**
 * SillyTavernchat Module - QRole refresh token encryption
 *
 * Refresh tokens are stored in the STC user metadata, which lives under the data root (in
 * production a JuiceFS mount backed by object storage). They are therefore encrypted with
 * AES-256-GCM using a key that stays LOCAL: `stc-mod-token.key` next to config.yaml (Docker:
 * `config/stc-mod-token.key`). Envelope: `v1.<iv>.<tag>.<ciphertext>` (base64url), the account
 * handle is bound as additional authenticated data so a token cannot be moved to another account.
 * If the key file cannot be created or read the feature degrades: nothing is stored or used and a
 * single warning is logged. Losing the key only means users have to log in with QRole again.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from '../config.js';

export const TOKEN_KEY_FILE = 'stc-mod-token.key';

const ENVELOPE_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// Longest refresh token accepted for storage
const MAX_TOKEN_LENGTH = 4096;
// After a key file failure, try again at most this often (the warning is logged only once)
const KEY_RETRY_MS = 5 * 60 * 1000;

/** @type {Buffer|null} */
let cachedKey = null;
let keyFailedAt = 0;
let keyWarningLogged = false;

/**
 * @param {Buffer|Uint8Array} key
 * @returns {boolean}
 */
function isValidKey(key) {
    return Buffer.isBuffer(key) && key.length === KEY_BYTES;
}

/**
 * Encrypt a token (AES-256-GCM, random 12-byte IV, AAD = account handle).
 * @param {string} plaintext Token
 * @param {string} aad Account handle
 * @param {Buffer} key 32-byte key
 * @returns {string} Envelope `v1.<iv>.<tag>.<ciphertext>`
 */
export function encryptToken(plaintext, aad, key) {
    if (!isValidKey(key)) throw new TypeError('Invalid token key');
    if (typeof plaintext !== 'string' || !plaintext) throw new TypeError('Nothing to encrypt');
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(String(aad), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENVELOPE_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/**
 * Decrypt an envelope. Never throws: tampered data, a wrong key or a wrong AAD yield null.
 * @param {*} envelope Envelope from encryptToken
 * @param {string} aad Account handle
 * @param {Buffer} key 32-byte key
 * @returns {string|null} Token, or null when it cannot be decrypted
 */
export function decryptToken(envelope, aad, key) {
    try {
        if (!isValidKey(key) || typeof envelope !== 'string') return null;
        const parts = envelope.split('.');
        if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) return null;
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        const ciphertext = Buffer.from(parts[3], 'base64url');
        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || !ciphertext.length) return null;
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(String(aad), 'utf8'));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        return plaintext || null;
    } catch {
        return null;
    }
}

/**
 * Parse the key file content (base64 of 32 bytes, surrounding whitespace ignored).
 * @param {string} text
 * @returns {Buffer|null}
 */
export function parseKeyFile(text) {
    const value = String(text ?? '').trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
    const key = Buffer.from(value, 'base64');
    return key.length === KEY_BYTES ? key : null;
}

/**
 * Read the key file, creating it (mode 0600) when it does not exist. Creation is race-safe: the
 * key is written to a private temp file (`wx`) and hard-linked into place, which fails if another
 * process created the file first (then that key is used). Filesystems without hard links fall back
 * to creating the file directly with `wx`.
 * @param {string} filePath
 * @returns {Buffer} Key
 * @throws When the file cannot be read, created or parsed
 */
export function loadOrCreateKeyFile(filePath) {
    const readKey = () => {
        const key = parseKeyFile(fs.readFileSync(filePath, 'utf8'));
        if (!key) throw new Error(`${path.basename(filePath)} does not contain a valid key`);
        return key;
    };

    try {
        return readKey();
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }

    const key = crypto.randomBytes(KEY_BYTES);
    const content = `${key.toString('base64')}\n`;
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, content, { flag: 'wx', mode: 0o600 });
    try {
        fs.linkSync(tmpPath, filePath);
        return key;
    } catch (error) {
        if (error?.code === 'EEXIST') return readKey();
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES'].includes(error?.code)) throw error;
    } finally {
        fs.rmSync(tmpPath, { force: true });
    }

    try {
        fs.writeFileSync(filePath, content, { flag: 'wx', mode: 0o600 });
        return key;
    } catch (error) {
        if (error?.code === 'EEXIST') return readKey();
        throw error;
    }
}

/**
 * Path of the local key file (next to the resolved config.yaml).
 * @returns {string}
 */
export function getTokenKeyPath() {
    return path.join(getConfigDir(), TOKEN_KEY_FILE);
}

/**
 * The token key, loading or creating the key file on first use. Null when unavailable.
 * @returns {Buffer|null}
 */
export function getTokenKey() {
    if (cachedKey) return cachedKey;
    if (keyFailedAt && Date.now() - keyFailedAt < KEY_RETRY_MS) return null;
    try {
        cachedKey = loadOrCreateKeyFile(getTokenKeyPath());
        keyFailedAt = 0;
        return cachedKey;
    } catch (error) {
        keyFailedAt = Date.now();
        if (!keyWarningLogged) {
            keyWarningLogged = true;
            console.warn(`[STC-MOD] QRole refresh tokens are disabled: the key file ${TOKEN_KEY_FILE} next to config.yaml could not be created or read (${error?.code || error?.message || 'unknown error'}). Users will need to log in with QRole again after their membership check window.`);
        }
        return null;
    }
}

/**
 * Whether tokens can currently be encrypted / decrypted.
 * @returns {boolean}
 */
export function isTokenKeyAvailable() {
    return getTokenKey() !== null;
}

/**
 * Encrypt a refresh token for an account with the local key.
 * @param {string} token Refresh token
 * @param {string} handle Account handle (AAD)
 * @returns {string|null} Envelope, or null when the key is unavailable or the token is unusable
 */
export function sealRefreshToken(token, handle) {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH || !handle) return null;
    const key = getTokenKey();
    if (!key) return null;
    try {
        return encryptToken(token, handle, key);
    } catch {
        return null;
    }
}

/**
 * Decrypt a stored refresh token of an account with the local key.
 * @param {*} envelope Stored `qroleRefreshToken`
 * @param {string} handle Account handle (AAD)
 * @returns {{ok: true, token: string}|{ok: false, reason: 'no_key'|'invalid'}}
 */
export function openRefreshToken(envelope, handle) {
    const key = getTokenKey();
    if (!key) return { ok: false, reason: 'no_key' };
    const token = decryptToken(envelope, handle, key);
    return token ? { ok: true, token } : { ok: false, reason: 'invalid' };
}
