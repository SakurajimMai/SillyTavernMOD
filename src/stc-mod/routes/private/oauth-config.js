/**
 * SillyTavernchat Module - OAuth Configuration (Admin)
 * Client secrets are write-only: GET never returns them (only `hasClientSecret`),
 * and POST keeps the stored secret when the submitted one is blank.
 */
import express from 'express';
import { requireAdminMiddleware } from '../../../users.js';
import { getStcConfig, setStcConfigs } from '../../config.js';
import { OAUTH_PROVIDERS } from '../../services/account-security.js';

export const router = express.Router();

const SAVE_FAILED_MESSAGE = '保存失败，请检查 config.yaml 写入权限';

const TOKEN_AUTH_METHODS = ['client_secret_post', 'client_secret_basic'];

/** Fields every provider accepts. */
const COMMON_STRING_FIELDS = ['clientId', 'callbackUrl'];
/** Providers with configurable endpoints. */
const ENDPOINT_PROVIDERS = ['linuxdo', 'qrole'];
const ENDPOINT_FIELDS = ['authUrl', 'tokenUrl', 'userInfoUrl'];
/** Fields whose value must be '' or an http(s) URL. */
const URL_FIELDS = ['callbackUrl', ...ENDPOINT_FIELDS];
/** QRole-only list fields (array or comma-separated string). */
const QROLE_LIST_FIELDS = ['allowedTiers', 'tierClaims', 'expiryClaims'];
/** QRole-only boolean fields. */
const QROLE_BOOLEAN_FIELDS = ['usePkce', 'requireMembership'];
/** QRole membership re-verification window (hours); 0 disables it. */
const DEFAULT_REVERIFY_HOURS = 24;
const MAX_REVERIFY_HOURS = 8760;

/**
 * Whether a value is '' or an absolute http(s) URL.
 * @param {string} value Trimmed value
 * @returns {boolean}
 */
function isEmptyOrHttpUrl(value) {
    if (value === '') return true;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Normalize a list value: array of strings or a comma-separated string.
 * @param {*} value Raw value from the request body
 * @param {boolean} lowercase Lowercase every entry
 * @returns {string[]|null} Normalized list, or null when the value is invalid
 */
function normalizeList(value, lowercase) {
    let items;
    if (typeof value === 'string') {
        items = value.split(',');
    } else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
        items = value;
    } else {
        return null;
    }
    const result = [];
    for (const item of items) {
        const trimmed = lowercase ? item.trim().toLowerCase() : item.trim();
        if (trimmed && !result.includes(trimmed)) result.push(trimmed);
    }
    return result;
}

router.get('/config', requireAdminMiddleware, (req, res) => {
    const config = {};
    for (const p of OAUTH_PROVIDERS) {
        const raw = getStcConfig(`oauth.${p}`, {});
        const providerConfig = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        // Never send the secret to the browser
        const { clientSecret, ...rest } = providerConfig;
        config[p] = {
            ...rest,
            hasClientSecret: typeof clientSecret === 'string' && clientSecret.length > 0,
        };
        if (p === 'qrole' && (config[p].reverifyHours === undefined || config[p].reverifyHours === null)) {
            config[p].reverifyHours = DEFAULT_REVERIFY_HOURS;
        }
    }
    res.json(config);
});

router.post('/config', requireAdminMiddleware, (req, res) => {
    try {
        const body = req.body ?? {};
        const { provider } = body;
        if (!provider) return res.status(400).json({ error: '缺少 provider 参数' });
        if (typeof provider !== 'string' || !OAUTH_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: '不支持的 OAuth 提供商' });
        }

        const isQrole = provider === 'qrole';
        const has = (key) => body[key] !== undefined && body[key] !== null;
        const prefix = `oauth.${provider}`;
        const entries = {};

        if (has('enabled')) entries[`${prefix}.enabled`] = !!body.enabled;

        // Plain string fields (trimmed); URL fields must be '' or http(s)
        const stringFields = [...COMMON_STRING_FIELDS];
        if (ENDPOINT_PROVIDERS.includes(provider)) stringFields.push(...ENDPOINT_FIELDS);
        if (isQrole) stringFields.push('scope');
        for (const field of stringFields) {
            if (!has(field)) continue;
            if (typeof body[field] !== 'string') {
                return res.status(400).json({ error: `${field} 格式无效` });
            }
            const value = body[field].trim();
            if (URL_FIELDS.includes(field) && !isEmptyOrHttpUrl(value)) {
                return res.status(400).json({ error: `${field} 必须为空或 http(s) 地址` });
            }
            entries[`${prefix}.${field}`] = value;
        }

        // Secret: blank (or missing) keeps the stored value
        if (typeof body.clientSecret === 'string' && body.clientSecret.trim()) {
            entries[`${prefix}.clientSecret`] = body.clientSecret.trim();
        }

        if (isQrole) {
            if (has('tokenAuthMethod')) {
                const method = typeof body.tokenAuthMethod === 'string' ? body.tokenAuthMethod.trim() : '';
                if (!TOKEN_AUTH_METHODS.includes(method)) {
                    return res.status(400).json({ error: `tokenAuthMethod 必须为 ${TOKEN_AUTH_METHODS.join(' 或 ')}` });
                }
                entries[`${prefix}.tokenAuthMethod`] = method;
            }

            for (const field of QROLE_BOOLEAN_FIELDS) {
                if (has(field)) entries[`${prefix}.${field}`] = !!body[field];
            }

            if (has('reverifyHours')) {
                const raw = body.reverifyHours;
                const hours = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
                if (!Number.isInteger(hours) || hours < 0 || hours > MAX_REVERIFY_HOURS) {
                    return res.status(400).json({ error: `reverifyHours 必须为 0-${MAX_REVERIFY_HOURS} 之间的整数` });
                }
                entries[`${prefix}.reverifyHours`] = hours;
            }

            for (const field of QROLE_LIST_FIELDS) {
                if (!has(field)) continue;
                const list = normalizeList(body[field], field === 'allowedTiers');
                if (!list) {
                    return res.status(400).json({ error: `${field} 必须为字符串数组或逗号分隔的字符串` });
                }
                entries[`${prefix}.${field}`] = list;
            }
        }

        if (Object.keys(entries).length > 0 && !setStcConfigs(entries)) {
            return res.status(500).json({ error: SAVE_FAILED_MESSAGE });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[STC-MOD] Save OAuth config error:', error);
        res.status(500).json({ error: SAVE_FAILED_MESSAGE });
    }
});
