/**
 * SillyTavernchat Module - Register Helper
 * Creates users by directly calling the official SillyTavern user storage APIs.
 * This avoids going through HTTP and requiring admin auth.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import storage from 'node-persist';
import lodash from 'lodash';
import { checkForNewContent, CONTENT_TYPES } from '../../../endpoints/content-manager.js';
import {
    toKey,
    getAllUserHandles,
    getPasswordSalt,
    getPasswordHash,
    getUserDirectories,
    ensurePublicDirectoriesExist,
} from '../../../users.js';
import { deleteUserMeta, findUserByOAuth, getUserMeta, setUserMeta } from '../../user-metadata.js';
import { applyRandomPassword, OAUTH_PROVIDERS } from '../../services/account-security.js';
import { getDefaultLimitMiB, isStorageLimitEnabled } from '../../services/storage-quota.js';
import { applyTemplate, getTemplateMeta } from '../../services/default-template.js';

/** Handles that self-registration (local or OAuth) may never claim. */
export const WEAK_NAMES = Object.freeze(['admin', 'root', 'system', 'test', 'null', 'undefined', 'default', 'default-user']);

const MAX_HANDLE_LENGTH = 32;
const HANDLE_SUFFIX_TRIES = 5;

function slugify(text) {
    return lodash.deburr(String(text ?? '').toLowerCase().trim()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Truncate a slug to a maximum length and strip trailing dashes.
 * @param {string} slug
 * @param {number} [maxLength]
 * @returns {string}
 */
function clampHandle(slug, maxLength = MAX_HANDLE_LENGTH) {
    return slug.substring(0, maxLength).replace(/-+$/g, '');
}

// In-process mutex (promise chain): serializes the "is this handle free?" check with the
// record write, so two concurrent registrations can never create/overwrite the same handle.
let handleLock = Promise.resolve();

/**
 * Run a task while holding the handle-allocation lock.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withHandleLock(task) {
    const run = handleLock.then(() => task());
    handleLock = run.then(() => undefined, () => undefined);
    return run;
}

/**
 * Whether a new account may take the handle: it has no official record and no data directory.
 * The official delete keeps the directory unless "purge" is ticked; a new account must never
 * inherit a deleted user's chats, secrets.json etc.
 * @param {string} handle
 * @param {Set<string>} takenHandles Handles that have an official record
 * @returns {boolean}
 */
function isHandleAvailable(handle, takenHandles) {
    return !takenHandles.has(handle) && !fs.existsSync(getUserDirectories(handle).root);
}

/**
 * Drop metadata left behind for a handle that has no official record (e.g. the account was
 * deleted through the official admin API). Must only be called right after the handle was
 * verified free, so stale OAuth links / expiry / quota are never inherited by a new account.
 * @param {string} handle
 */
function dropStaleMeta(handle) {
    if (getUserMeta(handle)) {
        console.warn('[STC-MOD] Removing stale metadata for re-used handle', handle);
        deleteUserMeta(handle);
    }
}

/**
 * Create the per-user data directories, like the official /api/users/create endpoint.
 * @param {string} handle
 */
async function ensureUserDirectories(handle) {
    console.info('[STC-MOD] Creating data directories for', handle);
    await ensurePublicDirectoriesExist();
    const directories = getUserDirectories(handle);
    await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
}

/**
 * Create a user using the same logic as the official /api/users/create endpoint.
 * @param {string} handle User handle (will be slugified)
 * @param {string} name Display name
 * @param {string} password Password (empty string for no password)
 * @returns {Promise<{success: boolean, handle?: string, error?: string}>}
 */
export async function createUser(handle, name, password = '') {
    try {
        const slugHandle = slugify(handle);

        if (!slugHandle) {
            return { success: false, error: '无效的用户标识' };
        }

        const created = await withHandleLock(async () => {
            if (!isHandleAvailable(slugHandle, new Set(await getAllUserHandles()))) {
                return false;
            }

            const salt = getPasswordSalt();
            const hashedPassword = password ? getPasswordHash(password, salt) : '';

            const newUser = {
                handle: slugHandle,
                name: name || 'Anonymous',
                created: Date.now(),
                password: hashedPassword,
                salt: salt,
                admin: false,
                enabled: true,
            };

            await storage.setItem(toKey(slugHandle), newUser);
            dropStaleMeta(slugHandle);
            return true;
        });

        if (!created) {
            return { success: false, error: '该用户名已被注册' };
        }

        try {
            await ensureUserDirectories(slugHandle);
        } catch (error) {
            // Do not leave an account behind that the registration reported as failed
            await rollbackCreatedUser(slugHandle);
            throw error;
        }

        return { success: true, handle: slugHandle };
    } catch (error) {
        console.error('[STC-MOD] Create user failed:', error);
        return { success: false, error: '创建用户失败' };
    }
}

/**
 * Candidate handles for an OAuth identity, in order of preference.
 * @param {string} provider
 * @param {string} id Provider user id
 * @param {string} username Provider username
 * @returns {string[]}
 */
function getOAuthHandleCandidates(provider, id, username) {
    const candidates = [];
    const fromName = clampHandle(slugify(username));
    if (fromName.length >= 2 && !WEAK_NAMES.includes(fromName)) {
        candidates.push(fromName);
    }
    const idSlug = slugify(id);
    candidates.push(clampHandle(idSlug ? `${provider}-${idSlug}` : `${provider}-user`));
    return [...new Set(candidates)];
}

/**
 * Pick the first free handle; if all candidates are taken, try random 4-hex suffixes.
 * @param {string[]} candidates
 * @param {(handle: string) => boolean} isFree
 * @returns {string|null}
 */
function pickFreeHandle(candidates, isFree) {
    const free = candidates.find(isFree);
    if (free) return free;
    const base = clampHandle(candidates[0], MAX_HANDLE_LENGTH - 5);
    for (let i = 0; i < HANDLE_SUFFIX_TRIES; i++) {
        const candidate = `${base}-${crypto.randomBytes(2).toString('hex')}`;
        if (isFree(candidate)) return candidate;
    }
    return null;
}

/**
 * Create an account for a new OAuth identity. The account gets a random, never-disclosed
 * password (so the handle-only password login cannot enter it) and is linked to the identity.
 * @param {object} identity
 * @param {string} identity.provider OAuth provider id (see OAUTH_PROVIDERS)
 * @param {string|number} identity.id Provider user id
 * @param {string} [identity.username] Provider username (preferred handle source)
 * @param {string} [identity.displayName] Display name for the account
 * @param {string} [identity.email] Email address
 * @param {string} [identity.avatar] Avatar URL
 * @param {object} [identity.extraMeta] Extra metadata to store (e.g. qroleTier, qroleMembershipExpiresAt)
 * @returns {Promise<{success: boolean, handle?: string, error?: string, conflict?: boolean}>}
 */
export async function createOAuthUser({ provider, id, username, displayName, email, avatar, extraMeta } = {}) {
    const providerStr = String(provider ?? '');
    const idStr = id === undefined || id === null ? '' : String(id);
    if (!OAUTH_PROVIDERS.includes(providerStr) || !idStr) {
        return { success: false, error: '缺少必要参数' };
    }

    try {
        const outcome = await withHandleLock(async () => {
            // Re-check under the lock: a concurrent callback may have linked this identity already
            if (findUserByOAuth(providerStr, idStr)) {
                return { error: '该第三方账号已绑定其他账户', conflict: true };
            }

            const taken = new Set(await getAllUserHandles());
            const candidates = getOAuthHandleCandidates(providerStr, idStr, username);
            const handle = pickFreeHandle(candidates, candidate => isHandleAvailable(candidate, taken));
            if (!handle) {
                return { error: '无法分配用户标识，请稍后重试' };
            }

            const now = Date.now();
            const newUser = {
                handle: handle,
                name: String(displayName || username || handle),
                created: now,
                password: '',
                salt: '',
                admin: false,
                enabled: true,
            };
            applyRandomPassword(newUser);

            await storage.setItem(toKey(handle), newUser);
            dropStaleMeta(handle);
            setUserMeta(handle, {
                ...(extraMeta && typeof extraMeta === 'object' ? extraMeta : {}),
                oauthProvider: providerStr,
                oauthUserId: idStr,
                email: email || null,
                avatar: avatar || null,
                expiresAt: 0,
                createdAt: newUser.created,
                lastLoginAt: now,
                lastActiveAt: now,
                storageLimitMiB: isStorageLimitEnabled() ? getDefaultLimitMiB() : undefined,
                hasPassword: false,
                passwordAutoGenerated: true,
                registrationMethod: providerStr,
            }, { immediate: true });

            return { handle, name: newUser.name };
        });

        if (!outcome.handle) {
            return { success: false, error: outcome.error, conflict: outcome.conflict === true };
        }

        try {
            await ensureUserDirectories(outcome.handle);
        } catch (error) {
            // Do not leave a linked account behind that the flow reported as failed
            await rollbackCreatedUser(outcome.handle);
            throw error;
        }

        if (getTemplateMeta()) {
            try {
                await applyTemplate(outcome.handle, { displayName: outcome.name });
            } catch (error) {
                // Template application is optional; do not block OAuth registration
                console.error('[STC-MOD] Apply template failed:', error?.message);
            }
        }

        console.info(`[STC-MOD] Created ${providerStr} OAuth account:`, outcome.handle);
        return { success: true, handle: outcome.handle };
    } catch (error) {
        console.error('[STC-MOD] Create OAuth user failed:', error);
        return { success: false, error: '创建用户失败' };
    }
}

/**
 * Undo an account created moments ago by this module (official record + STC metadata), e.g.
 * when a follow-up step such as consuming the invitation code fails. Data directories are kept.
 * @param {string} handle
 * @returns {Promise<void>}
 */
export async function rollbackCreatedUser(handle) {
    try {
        await storage.removeItem(toKey(handle));
        deleteUserMeta(handle);
        console.warn('[STC-MOD] Rolled back newly created account', handle);
    } catch (error) {
        console.error('[STC-MOD] Rollback of new account failed:', handle, error);
    }
}
