/**
 * SillyTavernchat Module - Storage Quota Enforcement Middleware
 *
 * Blocks write operations that can grow a user's data when the storage usage exceeds the limit.
 * Registered BEFORE the official routes in setupPublicRoutes (after the global JSON body parser and
 * setUserDataMiddleware, before multer), so it intercepts first.
 *
 * Rules:
 * - Deletions and renames are never blocked: any `DELETE` request and any `/api/...` POST whose last
 *   path segment is delete / remove / rename / clear / purge (e.g. /api/chats/delete,
 *   /api/backgrounds/rename, /api/backups/chat/delete). Anything not listed below is never blocked.
 * - Blocked when over quota: the exact write routes in BLOCKED_ROUTES and every POST under the
 *   upload prefixes (BLOCKED_PREFIXES) except their read-only routes (READ_ONLY_ROUTES).
 * - Over quota, /api/chats/save and /api/chats/group/save are still allowed when they make the chat
 *   file smaller (deleting messages); a save whose content is byte-identical to the stored file is
 *   answered `{ ok: true }` here without calling the official handler (nothing to write, and the
 *   official handler would add another full-size chat backup). /api/worldinfo/edit is allowed when
 *   the new file is not larger (the official handler keeps no backups of it). The target is resolved
 *   exactly like the official handler; a target that cannot be resolved safely or does not exist
 *   keeps the request blocked.
 * - Over quota, character card edits (/api/characters/edit, /edit-attribute, /merge-attributes) are
 *   allowed when the request is at most CARD_EDIT_ALLOWANCE_BYTES (multipart bodies are parsed only
 *   after this middleware, so the card cannot be compared; a card can grow by a bounded amount).
 * - Usage comes from the asynchronous usage cache (services/storage-quota.js); unknown usage (e.g. a
 *   remote read error) never blocks. Successful writes add pending bytes (for chat / world info
 *   saves the growth of the target file, otherwise the request size), successful deletions /
 *   renames trigger a prompt recount.
 *
 * Returns HTTP 507 Insufficient Storage with a JSON body so the frontend can show a themed prompt.
 */
import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { forbiddenRegExp } from '../../middleware/validateFileName.js';
import { isPathUnderParent } from '../../util.js';
import { getUserDirectories } from '../../users.js';
import { assertDataRootAvailable, isStoreUnavailableError, sendStoreUnavailable } from '../services/json-store.js';
import {
    ENFORCE_WAIT_MS,
    getUserStorageInfoAsync,
    isStorageLimitEnabled,
    recordUserFree,
    recordUserWrite,
} from '../services/storage-quota.js';

/** Methods that can write. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Last path segments of requests that free or keep space: never blocked. */
export const FREEING_SEGMENTS = Object.freeze(['delete', 'remove', 'rename', 'clear', 'purge']);
const FREEING_SEGMENT_SET = new Set(FREEING_SEGMENTS);

/**
 * Exact write routes blocked when over quota (lowercase, like normalizePath) → the check that may
 * still allow them over quota: a shrink check of the target file, `card-edit` (small requests), or
 * null (none).
 * @type {ReadonlyMap<string, 'chat'|'group-chat'|'worldinfo'|'card-edit'|null>}
 */
export const BLOCKED_ROUTES = new Map([
    // Chat data
    ['/api/chats/save', 'chat'],
    ['/api/chats/group/save', 'group-chat'],
    ['/api/chats/import', null],
    ['/api/chats/group/import', null],
    // Characters
    ['/api/characters/create', null],
    ['/api/characters/import', null],
    ['/api/characters/duplicate', null],
    ['/api/characters/edit-avatar', null],
    ['/api/characters/edit', 'card-edit'],
    ['/api/characters/edit-attribute', 'card-edit'],
    ['/api/characters/merge-attributes', 'card-edit'],
    // World info
    ['/api/worldinfo/edit', 'worldinfo'],
    ['/api/worldinfo/import', null],
    // Other content created from uploads, downloads or copies
    ['/api/avatars/upload', null],
    ['/api/groups/create', null],
    ['/api/content/importurl', null],
    ['/api/content/importuuid', null],
    ['/api/assets/download', null],
    ['/api/extensions/install', null],
]);

/**
 * Over quota, a character card edit is allowed up to this request size (bytes): typical edits pass,
 * and a card can grow by at most a few MiB (the card stores its JSON twice, base64-encoded).
 */
export const CARD_EDIT_ALLOWANCE_BYTES = 1024 * 1024;

/** Upload prefixes: every POST below them is a write unless read-only or freeing. */
export const BLOCKED_PREFIXES = Object.freeze(['/api/files', '/api/images', '/api/sprites', '/api/backgrounds']);

/**
 * Read-only POST routes under the blocked prefixes (checked against src/endpoints/*.js).
 * `/api/images/list` also covers the deprecated `/api/images/list/:folder`.
 */
export const READ_ONLY_ROUTES = Object.freeze([
    '/api/files/sanitize-filename',
    '/api/files/verify',
    '/api/images/list',
    '/api/images/folders',
    '/api/backgrounds/all',
    '/api/backgrounds/folders',
]);
const READ_ONLY_SET = new Set(READ_ONLY_ROUTES);

/**
 * Normalize a request path like Express matches it (case-insensitive, repeated and trailing
 * slashes ignored).
 * @param {string} rawPath
 * @returns {string}
 */
function normalizePath(rawPath) {
    return String(rawPath || '').toLowerCase().replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * @typedef {Object} RequestClass
 * @property {'none'|'read'|'free'|'write'} action
 * @property {'chat'|'group-chat'|'worldinfo'|'card-edit'|null} shrink Check that may allow the write over quota
 */

/** @type {RequestClass} */
const NONE = Object.freeze({ action: 'none', shrink: null });

/**
 * Classify a request for the quota check.
 * - free:  deletion / rename — never blocked, triggers a prompt recount
 * - write: blocked when over quota (unless the `shrink` check allows it: a save that does not grow
 *          its file, or a small card edit)
 * - read:  read-only route under an upload prefix — never blocked
 * - none:  not quota relevant — never blocked
 * @param {string} method HTTP method
 * @param {string} rawPath Full request path (req.path, e.g. /api/chats/save)
 * @returns {RequestClass}
 */
export function classifyRequest(method, rawPath) {
    const verb = String(method || '').toUpperCase();
    if (verb !== 'DELETE' && !WRITE_METHODS.has(verb)) return NONE;
    const p = normalizePath(rawPath);
    if (!p.startsWith('/api/') || p.startsWith('/api/stc/')) return NONE;

    const last = p.slice(p.lastIndexOf('/') + 1);
    if (verb === 'DELETE' || FREEING_SEGMENT_SET.has(last)) return { action: 'free', shrink: null };

    if (BLOCKED_ROUTES.has(p)) return { action: 'write', shrink: BLOCKED_ROUTES.get(p) };

    for (const prefix of BLOCKED_PREFIXES) {
        if (p === prefix || p.startsWith(prefix + '/')) {
            if (READ_ONLY_SET.has(p) || p.startsWith('/api/images/list/')) return { action: 'read', shrink: null };
            return { action: 'write', shrink: null };
        }
    }
    return NONE;
}

/**
 * Path of a file directly inside `dir` (null when `name` is empty or leaves the directory).
 * @param {string} dir
 * @param {string} name Sanitized file name
 * @returns {string|null}
 */
function childFile(dir, name) {
    if (!dir || !name) return null;
    const filePath = path.join(dir, name);
    if (!isPathUnderParent(dir, filePath) || path.resolve(filePath) === path.resolve(dir)) return null;
    return filePath;
}

/**
 * Path of the file a chat / group chat / world info save writes, exactly like the official handlers
 * (src/endpoints/chats.js POST /save and /group/save, src/endpoints/worldinfo.js POST /edit), or
 * null when the request cannot be resolved safely (the official handler rejects most of these).
 * @param {'chat'|'group-chat'|'worldinfo'} kind
 * @param {any} body Parsed JSON body
 * @param {{chats: string, groupChats: string, worlds: string}} directories User directories
 * @returns {string|null}
 */
export function resolveSaveTargetPath(kind, body, directories) {
    if (!body || typeof body !== 'object' || !directories) return null;
    try {
        if (kind === 'chat') {
            // validateAvatarUrlMiddleware + POST /api/chats/save
            if (forbiddenRegExp.test(String(body.avatar_url))) return null;
            if (!Array.isArray(body.chat) || !directories.chats) return null;
            const cardName = String(body.avatar_url).replace('.png', '');
            const chatFileName = `${String(body.file_name)}.jsonl`;
            const filePath = path.join(directories.chats, cardName, sanitize(chatFileName));
            return isPathUnderParent(directories.chats, filePath) ? filePath : null;
        }
        if (kind === 'group-chat') {
            // POST /api/chats/group/save
            if (!body.id || !Array.isArray(body.chat)) return null;
            return childFile(directories.groupChats, sanitize(`${body.id}.jsonl`));
        }
        if (kind === 'worldinfo') {
            // POST /api/worldinfo/edit
            const data = body.data;
            if (!body.name || !data || typeof data !== 'object' || !('entries' in data)) return null;
            return childFile(directories.worlds, sanitize(`${body.name}.json`));
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Resolve the file an over-quota save would replace and the size of the data it would write,
 * exactly like the official handlers (see resolveSaveTargetPath). Returns null when the request
 * cannot be resolved safely (it is then blocked).
 * @param {'chat'|'group-chat'|'worldinfo'} kind
 * @param {any} body Parsed JSON body
 * @param {{chats: string, groupChats: string, worlds: string}} directories User directories
 * @returns {{filePath: string, newSize: number}|null}
 */
export function resolveShrinkTarget(kind, body, directories) {
    const filePath = resolveSaveTargetPath(kind, body, directories);
    if (!filePath) return null;
    try {
        if (kind === 'worldinfo') {
            return { filePath, newSize: Buffer.byteLength(JSON.stringify(body.data, null, 4), 'utf8') };
        }
        const data = body.chat.map(m => JSON.stringify(m)).join('\n');
        return { filePath, newSize: Buffer.byteLength(data, 'utf8') };
    } catch {
        return null;
    }
}

/**
 * Whether an over-quota save may run: chat / group chat saves must make the file smaller (a
 * byte-identical save is `unchanged`: allowed, but answered without the official handler, which
 * would add a full-size chat backup); world info saves must not make it larger.
 * @param {'chat'|'group-chat'|'worldinfo'} kind
 * @param {any} body
 * @param {{chats: string, groupChats: string, worlds: string}} directories
 * @param {(filePath: string) => Promise<{size: number, isFile: () => boolean}>} [statFile]
 * @param {(filePath: string) => Promise<Buffer>} [readFile] Reads the stored file (equal-size chat saves)
 * @returns {Promise<{allowed: boolean, reason: string, unchanged?: boolean, newSize?: number, oldSize?: number}>}
 */
export async function checkShrinkingSave(kind, body, directories, statFile = p => fs.promises.stat(p), readFile = p => fs.promises.readFile(p)) {
    const target = resolveShrinkTarget(kind, body, directories);
    if (!target) return { allowed: false, reason: 'unresolved' };
    let stat;
    try {
        stat = await statFile(target.filePath);
    } catch (error) {
        return { allowed: false, reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable', newSize: target.newSize };
    }
    if (!stat.isFile()) return { allowed: false, reason: 'not_a_file', newSize: target.newSize };
    const sizes = { newSize: target.newSize, oldSize: stat.size };
    if (target.newSize > stat.size) return { allowed: false, reason: 'grows', ...sizes };
    if (kind === 'worldinfo' || target.newSize < stat.size) return { allowed: true, reason: 'shrinks', ...sizes };

    // Same size chat: only a byte-identical save (e.g. ST re-saving an unchanged chat) is allowed
    let stored;
    try {
        stored = await readFile(target.filePath);
    } catch {
        return { allowed: false, reason: 'unreadable', ...sizes };
    }
    const data = Buffer.from(body.chat.map(m => JSON.stringify(m)).join('\n'), 'utf8');
    if (Buffer.compare(stored, data) === 0) return { allowed: true, reason: 'unchanged', unchanged: true, ...sizes };
    return { allowed: false, reason: 'same_size_changed', ...sizes };
}

/**
 * Bytes a successful chat / world info save adds: the growth of the target file (its current size is
 * stat'ed now; a new file counts in full). For chats the request size stands in for the new file
 * size (the file holds the same messages, one per line), so the chat is not serialized twice.
 * Null when the target cannot be resolved or stat'ed (the caller falls back to the request size).
 * @param {'chat'|'group-chat'|'worldinfo'} kind
 * @param {import('express').Request} req
 * @param {{chats: string, groupChats: string, worlds: string}} directories
 * @param {(filePath: string) => Promise<{size: number, isFile: () => boolean}>} statFile
 * @returns {Promise<number|null>}
 */
export async function estimateSaveGrowth(kind, req, directories, statFile = p => fs.promises.stat(p)) {
    const filePath = resolveSaveTargetPath(kind, req.body, directories);
    if (!filePath) return null;
    let oldSize = 0;
    try {
        const stat = await statFile(filePath);
        if (!stat.isFile()) return null;
        oldSize = stat.size;
    } catch (error) {
        if (error?.code !== 'ENOENT') return null;
    }
    const header = req.headers?.['content-length'];
    const length = header === undefined ? NaN : Number(header);
    let newSize;
    if (kind !== 'worldinfo' && Number.isFinite(length) && length >= 0) {
        newSize = length;
    } else {
        const target = resolveShrinkTarget(kind, req.body, directories);
        if (!target) return null;
        newSize = target.newSize;
    }
    return Math.max(0, newSize - oldSize);
}

/**
 * Upper bound of the bytes a request may add: Content-Length, else the uploaded file + serialized body.
 * @param {import('express').Request} req
 * @returns {number}
 */
export function estimateRequestBytes(req) {
    const header = req.headers?.['content-length'];
    const length = header === undefined ? NaN : Number(header);
    if (Number.isFinite(length) && length >= 0) return length;
    let total = Number(req.file?.size) || 0;
    try {
        total += Buffer.byteLength(JSON.stringify(req.body ?? {}) || '', 'utf8');
    } catch {
        // Unserializable body: the file size is all we know
    }
    return total;
}

/**
 * Run `fn` when the response finished with a 2xx status.
 * @param {import('express').Response} res
 * @param {() => void} fn
 */
function onSuccess(res, fn) {
    if (typeof res.on !== 'function') return;
    res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
                fn();
            } catch (error) {
                console.warn('[STC-MOD] Storage usage tracking failed:', error?.message || error);
            }
        }
    });
}

const UNKNOWN_LOG_INTERVAL_MS = 5 * 60 * 1000;
/**
 * A user over the limit only because of the estimated bytes of recent writes is counted again
 * before a write is refused, unless the last count is younger than this (ms).
 */
export const FORCED_RECOUNT_MIN_AGE_MS = 5000;

/**
 * 507 message: how to free space.
 * @param {{usedMiB: number, limitMiB: number}} info
 * @returns {string}
 */
export function quotaExceededMessage(info) {
    return `存储空间已满（已用 ${info.usedMiB} MiB / 上限 ${info.limitMiB} MiB），无法执行写入操作。`
        + '请删除不需要的聊天或消息、角色卡、背景图片或聊天备份来释放空间（删除操作不受空间限制），或联系管理员扩容。';
}

/** "Quota check failed" warnings: at most one per user per this interval (ms). */
const FAILURE_LOG_INTERVAL_MS = 60 * 1000;

/**
 * Request size from Content-Length (NaN when absent / invalid).
 * @param {import('express').Request} req
 * @returns {number}
 */
function contentLength(req) {
    const header = req.headers?.['content-length'];
    const length = header === undefined ? NaN : Number(header);
    return Number.isFinite(length) && length >= 0 ? length : NaN;
}

/**
 * Create the enforcement middleware (dependencies injectable for tests).
 * @param {Object} [deps]
 * @param {() => boolean} [deps.isEnabled]
 * @param {(handle: string, opts?: {recount?: boolean}) => Promise<any>} [deps.getStorageInfo] Storage info
 *   (see buildStorageInfo); `recount: true` counts now
 * @param {(handle: string, bytes: number) => void} [deps.onWrite]
 * @param {(handle: string) => void} [deps.onFree]
 * @param {(filePath: string) => Promise<{size: number, isFile: () => boolean}>} [deps.statFile]
 * @param {(filePath: string) => Promise<Buffer>} [deps.readFile]
 * @param {(handle: string) => any} [deps.getDirectories]
 * @param {Pick<Console, 'warn'>} [deps.logger]
 * @returns {import('express').RequestHandler}
 */
export function createStorageEnforceMiddleware({
    isEnabled = isStorageLimitEnabled,
    getStorageInfo = (handle, { recount = false } = {}) => getUserStorageInfoAsync(handle, {
        waitMs: ENFORCE_WAIT_MS,
        ...(recount ? { maxAgeMs: 0 } : {}),
    }),
    onWrite = recordUserWrite,
    onFree = recordUserFree,
    statFile = p => fs.promises.stat(p),
    readFile = p => fs.promises.readFile(p),
    getDirectories = getUserDirectories,
    logger = console,
    assertAvailable = assertDataRootAvailable,
} = {}) {
    /** @type {Map<string, number>} */
    const lastUnknownLog = new Map();
    /** @type {Map<string, {at: number, suppressed: number}>} */
    const lastFailureLog = new Map();

    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {RequestClass} kind
     * @returns {Promise<{block: false, answered?: boolean}|{block: true, body: object}>}
     *   answered: the middleware sent the response itself (unchanged chat save)
     */
    async function decide(req, res, kind) {
        if (!isEnabled()) return { block: false };

        // Only check authenticated users
        const handle = req.user?.profile?.handle || req.session?.handle;
        if (!handle) return { block: false };

        if (kind.action === 'free') {
            onSuccess(res, () => onFree(handle));
            return { block: false };
        }
        if (kind.action !== 'write') return { block: false };

        let info = await getStorageInfo(handle);
        if (!info?.enabled) return { block: false };
        if (!info.canWrite && info.pendingMiB > 0 && info.usedMiB - info.pendingMiB < info.limitMiB
            && !(info.computedAt && Date.now() - info.computedAt < FORCED_RECOUNT_MIN_AGE_MS)) {
            // Over the limit only because of the estimated bytes of recent writes (an upper bound):
            // count now instead of refusing on the estimate
            info = await getStorageInfo(handle, { recount: true });
            if (!info?.enabled) return { block: false };
        }
        if (info.unknown) {
            const last = lastUnknownLog.get(handle) || 0;
            if (Date.now() - last >= UNKNOWN_LOG_INTERVAL_MS) {
                lastUnknownLog.set(handle, Date.now());
                logger.warn(`[STC-MOD] Storage usage of "${handle}" is unknown; allowing ${req.method} ${req.path} without a quota check`);
            }
        }

        const rule = kind.shrink;
        const isSave = rule === 'chat' || rule === 'group-chat' || rule === 'worldinfo';
        if (!info.canWrite) {
            if (rule === 'card-edit') {
                const length = contentLength(req);
                if (!(length <= CARD_EDIT_ALLOWANCE_BYTES)) return { block: true, body: quotaBody(info) };
            } else if (isSave) {
                const directories = req.user?.directories || getDirectories(handle);
                const shrink = await checkShrinkingSave(rule, req.body, directories, statFile, readFile);
                if (!shrink.allowed) return { block: true, body: quotaBody(info) };
                if (shrink.unchanged) {
                    // Nothing to write: answer like the official handler, without its full-size backup copy
                    res.status(200).json({ ok: true });
                    return { block: false, answered: true };
                }
            } else {
                return { block: true, body: quotaBody(info) };
            }
        }

        let bytes = null;
        if (isSave) {
            // The growth of the saved file, not the whole re-sent chat / world
            try {
                const directories = req.user?.directories || getDirectories(handle);
                bytes = await estimateSaveGrowth(rule, req, directories, statFile);
            } catch {
                bytes = null;
            }
        }
        onSuccess(res, () => onWrite(handle, bytes ?? estimateRequestBytes(req)));
        return { block: false };
    }

    /**
     * Log a failed quota check (rate limited per user).
     * @param {import('express').Request} req
     * @param {unknown} error
     */
    function logFailure(req, error) {
        const key = req.user?.profile?.handle || req.session?.handle || '';
        const now = Date.now();
        const last = lastFailureLog.get(key);
        if (last && now - last.at < FAILURE_LOG_INTERVAL_MS && now >= last.at) {
            last.suppressed++;
            return;
        }
        const suppressed = last?.suppressed || 0;
        if (lastFailureLog.size > 1000) lastFailureLog.clear();
        lastFailureLog.set(key, { at: now, suppressed: 0 });
        const more = suppressed ? ` (${suppressed} similar failures in the last minute not logged)` : '';
        logger.warn(`[STC-MOD] Storage quota check failed for ${req.method} ${req.path}; allowing${more}:`, /** @type {any} */ (error)?.message || error);
    }

    return async function storageEnforceMiddleware(req, res, next) {
        // Cheap synchronous path for everything that is not quota relevant (reads, static files, ...)
        const kind = classifyRequest(req.method, req.path);
        if (kind.action !== 'free' && kind.action !== 'write') return next();

        let decision;
        try {
            // Also checked by the data root write guard in front of every router; repeated here so a
            // quota-relevant write can never reach the official handler while the data root is gone
            assertAvailable();
            decision = await decide(req, res, kind);
            // decide() may wait for a usage count (up to ENFORCE_WAIT_MS, twice when recounting): the
            // mount can be lost meanwhile, so check again right before handing over to the handler
            if (!decision.block && !decision.answered) assertAvailable();
        } catch (error) {
            if (isStoreUnavailableError(error)) {
                // Store or data root unavailable (e.g. lost mount): the official handlers have no such
                // check and could create files in the empty directory under the mount, so never pass on
                return sendStoreUnavailable(req, res);
            }
            // Any other internal error: the quota must not lock users out (an unreadable usage count
            // does not get here, it is reported as unknown usage and never blocks)
            logFailure(req, error);
            decision = { block: false };
        }
        if (decision.block) {
            return res.status(507).json(decision.body);
        }
        if (decision.answered) return undefined;
        return next();
    };
}

/**
 * 507 body (shape unchanged: error, code, message, usedMiB, limitMiB, percent).
 * @param {{usedMiB: number, limitMiB: number, percent: number}} info
 */
function quotaBody(info) {
    return {
        error: true,
        code: 'STORAGE_QUOTA_EXCEEDED',
        message: quotaExceededMessage(info),
        usedMiB: info.usedMiB,
        limitMiB: info.limitMiB,
        percent: info.percent,
    };
}

/**
 * Express middleware factory.
 * Registers a single middleware on `app` that checks every relevant write request.
 * @param {import('express').Express} app
 */
export function registerStorageEnforceMiddleware(app) {
    app.use(createStorageEnforceMiddleware());
    console.log('[STC-MOD] Storage quota enforcement middleware registered.');
}
