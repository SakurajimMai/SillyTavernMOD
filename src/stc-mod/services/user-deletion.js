/**
 * SillyTavernchat Module - Account deletion
 * Full deletion of an account (official registry record + data directory + STC metadata), shared by
 * the admin user management routes and the QRole expired-account cleanup job.
 * Nothing is removed while the data root mount is lost or the user metadata cannot be read
 * (`skipped: 'store_unavailable'`, see services/json-store.js); the usage cache of the account is
 * dropped after every deletion attempt.
 */
import { promises as fsPromises } from 'node:fs';
import storage from 'node-persist';
import { toKey, getUserDirectories } from '../../users.js';
import { deleteUserMeta, ensureUserMetadataLoaded } from '../user-metadata.js';
import { STORE_UNAVAILABLE_MESSAGE, assertDataRootAvailable, isStoreUnavailableError } from './json-store.js';
import { invalidateUserUsage } from './storage-quota.js';

/** `skipped` reason of deleteUserWithLock when a data store is unavailable (nothing was removed). */
export const DELETION_STORE_UNAVAILABLE = 'store_unavailable';

// Fine-grained deletion locks: Map<handle, Promise>
// Each user's deletion operation is tracked independently, so concurrent deletions
// of different users proceed in parallel, but duplicate deletions of the same
// user are blocked until the first completes.
const userDeletionLocks = new Map();

/**
 * Acquire a deletion lock for a user. Returns a Promise that resolves when the
 * lock is acquired (i.e., no other deletion is in progress for this user).
 * @param {string} handle
 * @returns {Promise<() => void>} Resolves with a release function
 */
async function acquireUserDeletionLock(handle) {
    // Wait for any existing deletion of this user to complete
    while (userDeletionLocks.has(handle)) {
        await userDeletionLocks.get(handle);
    }

    // Create a new lock for this user
    let releaseFn;
    const lockPromise = new Promise(resolve => { releaseFn = resolve; });
    userDeletionLocks.set(handle, lockPromise);

    // Return a release function that removes the lock
    return () => {
        userDeletionLocks.delete(handle);
        releaseFn();
    };
}

/**
 * Whether a deletion of the account is in progress (lock held).
 * @param {string} handle
 * @returns {boolean}
 */
export function isUserDeletionInProgress(handle) {
    return userDeletionLocks.has(handle);
}

/**
 * Wait until no deletion of the account is in progress. Login paths use this so that they never
 * resume an account that is being deleted (they look the account up again afterwards).
 * @param {string} handle
 * @returns {Promise<void>}
 */
export async function waitForUserDeletion(handle) {
    while (userDeletionLocks.has(handle)) {
        await userDeletionLocks.get(handle);
    }
}

/**
 * Delete a single user with all their data (registry + files + metadata).
 * Wrapped with a lock to prevent concurrent deletion of the same user.
 * @param {string} handle
 * @param {{precheck?: () => (string|null|Promise<string|null>)}} [opts] precheck: runs while the
 *   lock is held, right before anything is removed; a returned reason cancels the deletion
 *   (automatic jobs use it to re-check that the account is still eligible)
 * @returns {Promise<{success: boolean, error: string, skipped?: string}>} `skipped`: the precheck
 *   cancelled the deletion, or 'store_unavailable' (data root / metadata unavailable); nothing was removed
 */
export async function deleteUserWithLock(handle, { precheck } = {}) {
    if (!handle || handle === 'default-user') {
        return { success: false, error: 'Invalid or protected handle' };
    }

    const release = await acquireUserDeletionLock(handle);
    try {
        try {
            // A lost mount makes every path resolve to the empty directory underneath, and the
            // metadata must be loaded before its entry can be removed: delete nothing in either case
            assertDataRootAvailable();
            ensureUserMetadataLoaded();
        } catch (error) {
            if (!isStoreUnavailableError(error)) throw error;
            return { success: false, error: STORE_UNAVAILABLE_MESSAGE, skipped: DELETION_STORE_UNAVAILABLE };
        }
        if (precheck) {
            const veto = await precheck();
            if (veto) return { success: false, error: '', skipped: String(veto) };
        }

        // 1. Remove from SillyTavern user registry (node-persist)
        await storage.removeItem(toKey(handle));

        // 2. Delete user data directory (chats, characters, backups, etc.)
        const dirs = getUserDirectories(handle);
        await fsPromises.rm(dirs.root, { recursive: true, force: true });

        // 3. Remove STC extended metadata
        deleteUserMeta(handle);

        return { success: true, error: '' };
    } catch (error) {
        return { success: false, error: error.message || 'Unknown error' };
    } finally {
        invalidateUserUsage(handle);
        release();
    }
}
