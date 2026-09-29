/**
 * SillyTavernchat Module - user privacy vault routes.
 * A vault record that cannot be read answers 503 STORE_UNAVAILABLE (never "not enabled"); a corrupt
 * one 500 VAULT_RECORD_CORRUPT (see services/privacy-vault.js).
 */
import express from 'express';
import { SecretManager } from '../../../endpoints/secrets.js';
import {
    VaultLockedError,
    VaultRecordCorruptError,
    VaultRequiredError,
    getVaultStatus,
    lockVault,
    unlockVault,
} from '../../services/privacy-vault.js';
import { respondStoreError } from '../../services/json-store.js';

export const router = express.Router();

/**
 * Answer a vault error with the matching HTTP status (VAULT_LOCKED / VAULT_REQUIRED like secrets.js,
 * STORE_UNAVAILABLE 503, VAULT_RECORD_CORRUPT 500).
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {any} error
 */
export function sendVaultError(request, response, error) {
    if (error instanceof VaultLockedError) {
        return response.status(423).send({ error: true, code: 'VAULT_LOCKED', message: error.message });
    }
    if (error instanceof VaultRequiredError) {
        return response.status(428).send({ error: true, code: 'VAULT_REQUIRED', message: error.message });
    }
    if (respondStoreError(request, response, error)) return response;
    if (error instanceof VaultRecordCorruptError) {
        return response.status(500).send({ error: true, code: error.code, message: error.message });
    }
    return response.status(500).send({
        error: true,
        message: error.message || 'Internal server error',
    });
}

/**
 * Endpoint to get the current vault status for the logged-in user.
 */
router.post('/status', (request, response) => {
    try {
        const directories = request.user.directories;
        const status = getVaultStatus(directories);
        return response.json(status);
    } catch (error) {
        console.error('[STC-MOD] Vault /status error:', error);
        return sendVaultError(request, response, error);
    }
});

/**
 * Endpoint to enable the vault for the first time.
 * This also triggers encryption of all existing plaintext API keys.
 */
router.post('/enable', async (request, response) => {
    try {
        const directories = request.user.directories;
        const passphrase = request.body?.passphrase;

        if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 8) {
            return response.status(400).send({ error: true, message: 'Invalid or missing passphrase. Must be at least 8 characters.' });
        }

        const sm = new SecretManager(directories);
        const encryptedCount = await sm.enableVault(passphrase);

        const status = getVaultStatus(directories);
        return response.json({ success: true, status, encryptedCount });
    } catch (error) {
        console.error('[STC-MOD] Vault /enable error:', error);
        return sendVaultError(request, response, error);
    }
});

/**
 * Endpoint to unlock an existing vault with a passphrase.
 */
router.post('/unlock', (request, response) => {
    try {
        const directories = request.user.directories;
        const passphrase = request.body?.passphrase;

        if (!passphrase || typeof passphrase !== 'string') {
            return response.status(400).send({ error: true, message: 'Invalid or missing passphrase.' });
        }

        try {
            unlockVault(directories, passphrase);
            const status = getVaultStatus(directories);
            return response.json({ success: true, status });
        } catch (e) {
            if (e.message === 'Invalid passphrase') {
                return response.status(401).send({ error: true, message: 'Incorrect password.' });
            }
            throw e;
        }
    } catch (error) {
        console.error('[STC-MOD] Vault /unlock error:', error);
        return sendVaultError(request, response, error);
    }
});

/**
 * Endpoint to manually lock the vault immediately.
 */
router.post('/lock', (request, response) => {
    try {
        const directories = request.user.directories;
        lockVault(directories);
        const status = getVaultStatus(directories);
        return response.json({ success: true, status });
    } catch (error) {
        console.error('[STC-MOD] Vault /lock error:', error);
        return sendVaultError(request, response, error);
    }
});

/**
 * Endpoint to reset (forget password) the vault.
 *
 * This is a destructive action: the vault record is deleted and every
 * vault-encrypted API key in secrets.json is removed. The user must
 * explicitly confirm by sending `{ confirm: 'RESET' }` in the body, so
 * accidental clicks cannot wipe keys.
 *
 * After reset, the user can either:
 *   - re-enable the vault with a new passphrase (and re-enter keys), or
 *   - continue to save keys as plaintext (only if `requireForApiKeys`
 *     is false in config.yaml).
 */
router.post('/reset', (request, response) => {
    try {
        const directories = request.user.directories;
        const confirm = request.body?.confirm;

        if (confirm !== 'RESET') {
            return response.status(400).send({
                error: true,
                message: 'Reset must be confirmed with {"confirm":"RESET"}.',
            });
        }

        const sm = new SecretManager(directories);
        const { existed, removedKeys } = sm.resetVaultAndClearEncryptedKeys();
        const status = getVaultStatus(directories);

        console.log(`[STC-MOD] Vault: User ${directories.user} reset vault (existed=${existed}, removedKeys=${removedKeys}).`);

        return response.json({ success: true, existed, removedKeys, status });
    } catch (error) {
        console.error('[STC-MOD] Vault /reset error:', error);
        return sendVaultError(request, response, error);
    }
});
