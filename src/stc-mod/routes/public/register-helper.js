/**
 * SillyTavernchat Module - Register Helper
 * Creates users by directly calling the official SillyTavern user storage APIs.
 * This avoids going through HTTP and requiring admin auth.
 *
 * Store failures: the data root guard and the user metadata are checked BEFORE the official record
 * is created, so an unavailable store never leaves an account without its metadata (or, for OAuth,
 * creates a second account for an identity whose link just cannot be read). Right before the record
 * is written (after the awaits of the free-handle check) the handle is verified again with the guard
 * checked around a fresh read (isAccountRecordGone): a check that ran against a vanished mount (every
 * record ENOENT, no user directory) never lets a new account overwrite an existing one or drop its
 * metadata.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import storage from 'node-persist';
import lodash from 'lodash';
import {
    toKey,
    getAllUserHandles,
    getPasswordSalt,
    getPasswordHash,
    getUserDirectories,
    ensurePublicDirectoriesExist,
} from '../../../users.js';
import { deleteUserMeta, ensureUserMetadataLoaded, findUserByOAuth, getUserMeta, setUserMeta } from '../../user-metadata.js';
import { applyRandomPassword, OAUTH_PROVIDERS } from '../../services/account-security.js';
import { getDefaultLimitMiB, isStorageLimitEnabled } from '../../services/storage-quota.js';
import { applyTemplate, getTemplateMeta } from '../../services/default-template.js';
import { seedNewUserContent } from '../../services/user-content-seed.js';
import { getDataRoot } from '../../config.js';
import {
    STORE_UNAVAILABLE_MESSAGE,
    StoreUnavailableError,
    assertDataRootAvailable,
    isStoreUnavailableError,
} from '../../services/json-store.js';

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
 * Whether the official account record of `handle` is really absent. node-persist reads ENOENT as
 * "no record", and while the data root mount is gone every record is ENOENT: the data root guard is
 * checked before and after a fresh read, and the record directory (created at startup) must exist.
 * Use before acting on a missing record (clearing an OAuth link, taking over a handle).
 * @param {string} handle
 * @returns {Promise<boolean>}
 * @throws {StoreUnavailableError} The data root or the record directory is not available
 */
export async function isAccountRecordGone(handle) {
    assertDataRootAvailable();
    const recordDir = path.join(getDataRoot(), '_storage');
    let stat;
    try {
        stat = await fs.promises.stat(recordDir);
    } catch (error) {
        throw new StoreUnavailableError(`account records ${recordDir} cannot be stat'ed (${error?.code || error?.message})`, { cause: error });
    }
    if (!stat.isDirectory()) throw new StoreUnavailableError(`account records ${recordDir} is not a directory`);
    let record;
    try {
        record = await storage.getItem(toKey(handle));
    } catch (error) {
        throw new StoreUnavailableError(`account record of ${handle} cannot be read (${error?.code || error?.message})`, { cause: error });
    }
    assertDataRootAvailable();
    return !record;
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
 * Create the per-user data directories and seed the default content, like the official
 * /api/users/create endpoint (config.yaml `newUserContent: minimal` seeds only settings.json and
 * the default persona avatar, see services/user-content-seed.js).
 * @param {string} handle
 */
async function ensureUserDirectories(handle) {
    console.info('[STC-MOD] Creating data directories for', handle);
    await ensurePublicDirectoriesExist();
    const directories = getUserDirectories(handle);
    await seedNewUserContent(directories);
}

/**
 * Create a user using the same logic as the official /api/users/create endpoint.
 * @param {string} handle User handle (will be slugified)
 * @param {string} name Display name
 * @param {string} password Password (empty string for no password)
 * @returns {Promise<{success: boolean, handle?: string, error?: string, unavailable?: boolean}>}
 *   `unavailable`: a data store could not be read, nothing was created (error = the zh-CN 503 text)
 */
export async function createUser(handle, name, password = '') {
    try {
        const slugHandle = slugify(handle);

        if (!slugHandle) {
            return { success: false, error: '无效的用户标识' };
        }

        const created = await withHandleLock(async () => {
            // Before anything is created: the metadata written right after must be available
            assertDataRootAvailable();
            ensureUserMetadataLoaded();
            if (!isHandleAvailable(slugHandle, new Set(await getAllUserHandles()))) {
                return false;
            }
            // Again right before the write: the checks above may have run against a vanished mount
            if (!await isAccountRecordGone(slugHandle) || !isHandleAvailable(slugHandle, new Set())) {
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
        if (isStoreUnavailableError(error)) {
            console.error('[STC-MOD] Create user refused: data store unavailable', error.detail || error.message);
            return { success: false, error: STORE_UNAVAILABLE_MESSAGE, unavailable: true };
        }
        console.error('[STC-MOD] Create user failed:', error);
        return { success: false, error: '创建用户失败' };
    }
}

/**
 * Candidate handles for an OAuth identity, in order of preference: the provider username
 * (e.g. `alice`), then the provider-prefixed username when that is reserved or taken
 * (e.g. `qrole-admin`), then the provider-prefixed user id.
 * @param {string} provider
 * @param {string} id Provider user id
 * @param {string} username Provider username
 * @returns {string[]}
 */
export function getOAuthHandleCandidates(provider, id, username) {
    const candidates = [];
    const fromName = clampHandle(slugify(username));
    if (fromName.length >= 2 && !WEAK_NAMES.includes(fromName)) {
        candidates.push(fromName);
    }
    if (fromName) {
        candidates.push(clampHandle(`${provider}-${fromName}`));
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
 * @throws {import('../../services/json-store.js').StoreUnavailableError} The OAuth links cannot be
 *   read (nothing was created)
 */
export async function createOAuthUser({ provider, id, username, displayName, email, avatar, extraMeta } = {}) {
    const providerStr = String(provider ?? '');
    const idStr = id === undefined || id === null ? '' : String(id);
    if (!OAUTH_PROVIDERS.includes(providerStr) || !idStr) {
        return { success: false, error: '缺少必要参数' };
    }

    try {
        const outcome = await withHandleLock(async () => {
            assertDataRootAvailable();
            // Re-check under the lock: a concurrent callback may have linked this identity already
            // (throws while the metadata is unavailable: never a second account for a linked identity)
            if (findUserByOAuth(providerStr, idStr)) {
                return { error: '该第三方账号已绑定其他账户', conflict: true };
            }

            const taken = new Set(await getAllUserHandles());
            const candidates = getOAuthHandleCandidates(providerStr, idStr, username);
            const handle = pickFreeHandle(candidates, candidate => isHandleAvailable(candidate, taken));
            if (!handle) {
                return { error: '无法分配用户标识，请稍后重试' };
            }
            // Again right before the write: the checks above may have run against a vanished mount
            // (the record would overwrite an existing account and drop its metadata)
            if (!await isAccountRecordGone(handle) || !isHandleAvailable(handle, new Set())) {
                return { error: '无法分配用户标识，请稍后重试' };
            }
            if (findUserByOAuth(providerStr, idStr)) {
                return { error: '该第三方账号已绑定其他账户', conflict: true };
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

        try {
            if (getTemplateMeta()) {
                await applyTemplate(outcome.handle, { displayName: outcome.name });
            }
        } catch (error) {
            // Template application is optional (also when its store is unavailable); do not block OAuth registration
            console.error('[STC-MOD] Apply template failed:', error?.detail || error?.message);
        }

        console.info(`[STC-MOD] Created ${providerStr} OAuth account:`, outcome.handle);
        return { success: true, handle: outcome.handle };
    } catch (error) {
        if (isStoreUnavailableError(error)) throw error;
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
