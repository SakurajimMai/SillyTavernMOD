/**
 * SillyTavernchat Module - QRole export-only session
 *
 * A QRole user whose membership lapsed (or who is not a member) but already has an account here is
 * not logged in; instead the OAuth callback stores a short-lived export session
 * (`req.session.stcQroleExport`) that grants exactly one thing: the /qrole-expired page with a
 * download of the account's data. It never sets `req.session.handle`, so neither the official nor
 * the STC middleware treat the browser as logged in (setUserDataMiddleware only reads `handle`).
 */
import storage from 'node-persist';
import { toKey, getAccountVersion } from '../../users.js';
import { getConfigValue } from '../../util.js';
import { getUserMeta } from '../user-metadata.js';
import { isMetaForRecord } from './account-security.js';
import { getQroleLifecycleConfig } from './qrole-lifecycle.js';

/** Lifetime of an export session. */
export const EXPORT_SESSION_TTL_MS = 30 * 60 * 1000;
export const EXPORT_EXPIRED_MESSAGE = '数据导出链接已失效，请重新使用 QRole 登录';
export const EXPORT_EXPIRED_CODE = 'EXPORT_EXPIRED';

/**
 * @typedef {Object} QroleExportSession
 * @property {string} handle Account handle
 * @property {string} oauthUserId QRole user id the account was linked to at the callback
 * @property {string} version Official account version at the callback (password / salt changes void it)
 * @property {'membership_expired'|'not_member'} reason Why the login was denied
 * @property {number} createdAt
 */

/**
 * @typedef {{status: 'none'}|{status: 'invalid'}|{status: 'valid', session: QroleExportSession, record: object, meta: object}} ExportSessionState
 */

/**
 * Whether the official full data backup is allowed (`backups.allowFullDataBackup`).
 * @returns {boolean}
 */
export function isFullBackupAllowed() {
    return !!getConfigValue('backups.allowFullDataBackup', true, 'boolean');
}

/**
 * @param {*} value
 * @returns {value is QroleExportSession}
 */
function isExportSessionShape(value) {
    return !!value && typeof value === 'object'
        && typeof value.handle === 'string' && !!value.handle
        && typeof value.oauthUserId === 'string' && !!value.oauthUserId
        && typeof value.version === 'string' && !!value.version
        && typeof value.reason === 'string'
        && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt);
}

/**
 * Start an export session in the browser session. Any login of this browser is ended: the user
 * just authenticated as the QRole account, so the session must not stay bound to another account.
 * @param {import('express').Request} req
 * @param {{handle: string, oauthUserId: string, record: object, reason: 'membership_expired'|'not_member'}} params
 */
export function startExportSession(req, { handle, oauthUserId, record, reason }) {
    req.session.handle = null;
    req.session.version = null;
    req.session.stcOauthPending = null;
    req.session.stcQroleExport = {
        handle,
        oauthUserId: String(oauthUserId),
        version: getAccountVersion(record),
        reason,
        createdAt: Date.now(),
    };
}

/**
 * Drop the export session (logout, successful login, invalid session).
 * @param {import('express').Request} req
 */
export function clearExportSession(req) {
    if (req.session && req.session.stcQroleExport) {
        req.session.stcQroleExport = null;
    }
}

/**
 * Validate the export session of a request (checked on every export request): present, created
 * within 30 minutes, the account still exists, is still linked to the same QRole user (live
 * metadata), is enabled, is not an admin and has the same account version; the feature must still
 * be enabled. Ignored entirely while the browser is logged in (`req.session.handle`).
 * @param {import('express').Request} req
 * @param {number} [now]
 * @returns {Promise<ExportSessionState>}
 */
export async function resolveExportSession(req, now = Date.now()) {
    const session = req.session?.stcQroleExport;
    if (!session || req.session?.handle) return { status: 'none' };
    if (!isExportSessionShape(session)) return { status: 'invalid' };
    if (now - session.createdAt > EXPORT_SESSION_TTL_MS || session.createdAt > now + 60 * 1000) return { status: 'invalid' };

    const lifecycle = getQroleLifecycleConfig();
    if (!lifecycle.expiredDataExport || !lifecycle.requireMembership) return { status: 'invalid' };

    const record = await storage.getItem(toKey(session.handle));
    if (!record || record.enabled === false || record.admin) return { status: 'invalid' };
    const meta = getUserMeta(session.handle);
    if (!meta || !isMetaForRecord(meta, record)) return { status: 'invalid' };
    if (meta.oauthProvider !== 'qrole' || String(meta.oauthUserId) !== session.oauthUserId) return { status: 'invalid' };
    if (getAccountVersion(record) !== session.version) return { status: 'invalid' };

    return { status: 'valid', session, record, meta };
}
