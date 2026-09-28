/**
 * SillyTavernchat Module - OAuth provider client helpers
 *
 * Shared by the OAuth login routes and the QRole background re-verification: provider endpoints,
 * JSON requests with timeouts and size limits (never logging bodies or tokens), the QRole token
 * endpoint client authentication and the identity normalization used at login.
 */

/** Built-in endpoints. Only linuxdo and qrole may override the URLs from config. */
export const PROVIDER_DEFAULTS = Object.freeze({
    github: Object.freeze({
        authUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
        scope: 'read:user user:email',
    }),
    discord: Object.freeze({
        authUrl: 'https://discord.com/api/oauth2/authorize',
        tokenUrl: 'https://discord.com/api/oauth2/token',
        userInfoUrl: 'https://discord.com/api/users/@me',
        scope: 'identify email',
    }),
    linuxdo: Object.freeze({
        authUrl: 'https://connect.linux.do/oauth2/authorize',
        tokenUrl: 'https://connect.linux.do/oauth2/token',
        userInfoUrl: 'https://connect.linux.do/api/user',
        scope: '',
    }),
    qrole: Object.freeze({
        authUrl: 'https://www.qqy.one/api/oauth/authorize',
        tokenUrl: 'https://www.qqy.one/api/oauth/token',
        userInfoUrl: 'https://www.qqy.one/api/oauth/userinfo',
        // `membership` makes QRole's userinfo return membership_tier / membership_expires_at
        scope: 'openid profile email membership',
    }),
});

// Timeout for a request to the OAuth provider when the caller passes no signal
const DEFAULT_TIMEOUT_MS = 15 * 1000;
// Responses larger than this are rejected without being parsed
const DEFAULT_MAX_BYTES = 1024 * 1024;

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const MAX_AVATAR_LENGTH = 512;
const MAX_TIER_NAME_LENGTH = 64;

/**
 * Read a config value as a trimmed string (YAML may turn numeric client ids into numbers).
 * @param {*} value
 * @returns {string}
 */
export function configString(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

/**
 * Provider endpoint URL (authUrl / tokenUrl / userInfoUrl).
 * @param {string} provider
 * @param {object} config Provider config (`oauth.<provider>`)
 * @param {'authUrl'|'tokenUrl'|'userInfoUrl'} key
 * @returns {string}
 */
export function getEndpoint(provider, config, key) {
    if (provider === 'linuxdo' || provider === 'qrole') {
        const configured = configString(config?.[key]);
        if (configured) return configured;
    }
    return PROVIDER_DEFAULTS[provider][key];
}

/**
 * Describe a fetch failure without echoing anything that could contain secrets.
 * @param {*} error
 * @returns {string}
 */
export function describeFetchError(error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
    return String(error?.cause?.code || error?.name || 'network error');
}

/**
 * Read a response body as text, giving up once it exceeds `maxBytes`.
 * @param {Response} resp
 * @param {number} maxBytes
 * @returns {Promise<string|null>} Body text, or null when it is too large
 */
async function readLimitedText(resp, maxBytes) {
    const declared = Number(resp.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await resp.body?.cancel().catch(() => {});
        return null;
    }
    if (!resp.body) return '';
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse a JSON object (arrays and primitives are rejected).
 * @param {string|null} text
 * @returns {object|null}
 */
function parseJsonObject(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
        const data = JSON.parse(text);
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
        // Parse errors may quote the body (tokens); never surface them
        return null;
    }
}

/**
 * @typedef {Object} JsonRequestResult
 * @property {boolean} ok Whether the request succeeded (2xx and a JSON object body)
 * @property {null|'invalid_url'|'network'|'timeout'|'http'|'parse'|'too_large'} failure Failure class
 * @property {number|null} status HTTP status, when a response was received
 * @property {object|null} data Parsed JSON object (also for error responses, when parsable)
 * @property {string} detail Log-safe description of the failure
 */

/**
 * Request JSON from a provider and classify the outcome. Never throws and never logs.
 * @param {string} url
 * @param {RequestInit} init
 * @param {{signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<JsonRequestResult>}
 */
export async function requestJsonDetailed(url, init, opts = {}) {
    /** @type {(failure: JsonRequestResult['failure'], detail: string, status?: number|null, data?: object|null) => JsonRequestResult} */
    const fail = (failure, detail, status = null, data = null) => ({ ok: false, failure, status, data, detail });

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        return fail('invalid_url', 'URL is invalid');
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        return fail('invalid_url', 'URL must be http(s)');
    }

    const fetchImpl = opts.fetchImpl || fetch;
    const signal = opts.signal || AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;

    let resp;
    let text;
    try {
        resp = await fetchImpl(parsedUrl, { ...init, signal });
        text = await readLimitedText(resp, maxBytes);
    } catch (error) {
        const detail = describeFetchError(error);
        return fail(detail === 'timeout' ? 'timeout' : 'network', detail, resp?.status ?? null);
    }

    if (text === null) {
        return fail('too_large', 'response is too large', resp.status);
    }
    const data = parseJsonObject(text);
    if (!resp.ok) {
        return fail('http', `HTTP ${resp.status}`, resp.status, data);
    }
    if (!data) {
        return fail('parse', 'response is not a JSON object', resp.status);
    }
    return { ok: true, failure: null, status: resp.status, data, detail: '' };
}

/**
 * Request JSON from the provider. Never throws; failures are logged (status only) and yield null.
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} label Log label, e.g. 'github token'
 * @returns {Promise<object|null>}
 */
export async function requestJson(url, init, label) {
    const result = await requestJsonDetailed(url, init);
    if (result.ok) return result.data;
    console.warn(`[STC-MOD] OAuth ${label} ${result.failure === 'invalid_url' ? result.detail : `request failed: ${result.detail}`}`);
    return null;
}

/**
 * Body and headers of a request to the QRole token endpoint, with the configured client
 * authentication (client_secret_post: credentials in the body; client_secret_basic: HTTP Basic).
 * Used for both the authorization code exchange and the refresh token grant.
 * @param {object} config `oauth.qrole` config
 * @param {Record<string, string>} fields Grant fields (grant_type, code, refresh_token, ...)
 * @returns {{headers: Record<string, string>, body: string}}
 */
export function buildQroleTokenRequest(config, fields) {
    const clientId = configString(config?.clientId);
    const clientSecret = configString(config?.clientSecret);
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
    const params = new URLSearchParams(fields);
    if (config?.tokenAuthMethod === 'client_secret_basic') {
        const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
        headers['Authorization'] = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
    } else {
        params.set('client_id', clientId);
        if (clientSecret) params.set('client_secret', clientSecret);
    }
    return { headers, body: params.toString() };
}

/**
 * First value that is a non-empty string or a finite number.
 * @param {...*} values
 * @returns {string|number|undefined}
 */
export function pickClaim(...values) {
    return values.find(value => (typeof value === 'string' && value.trim() !== '') || (typeof value === 'number' && Number.isFinite(value)));
}

/**
 * Printable, trimmed, length-limited text, or null.
 * @param {*} value
 * @param {number} maxLength
 * @returns {string|null}
 */
export function cleanText(value, maxLength) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).replace(/\p{Cc}/gu, '').trim();
    return text ? text.slice(0, maxLength) : null;
}

/**
 * @param {*} value
 * @returns {string|null}
 */
function cleanEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim();
    if (!email || email.length > MAX_EMAIL_LENGTH || /\s/.test(email) || !email.includes('@')) return null;
    return email;
}

/**
 * Only http(s) avatar URLs are kept.
 * @param {*} value
 * @returns {string|null}
 */
function cleanAvatar(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_AVATAR_LENGTH) return null;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
        return null;
    }
}

/**
 * @typedef {Object} OAuthIdentity
 * @property {string} id Provider user id
 * @property {string|null} username
 * @property {string|null} displayName
 * @property {string|null} email
 * @property {string|null} avatar
 */

/**
 * Normalize a provider identity. Returns null when there is no usable user id.
 * @param {{id: *, username: *, displayName: *, email: *, avatar: *}} raw
 * @returns {OAuthIdentity|null}
 */
export function normalizeIdentity({ id, username, displayName, email, avatar }) {
    const idStr = cleanText(id, MAX_ID_LENGTH + 1);
    if (!idStr || idStr.length > MAX_ID_LENGTH) return null;
    return {
        id: idStr,
        username: cleanText(username, MAX_NAME_LENGTH),
        displayName: cleanText(displayName, MAX_NAME_LENGTH),
        email: cleanEmail(email),
        avatar: cleanAvatar(avatar),
    };
}

/**
 * Normalize a QRole userinfo response (the same identity extraction for login and re-verification).
 * The QRole `role` claim is never used.
 * @param {object} data QRole userinfo response
 * @returns {OAuthIdentity|null}
 */
export function parseQroleIdentity(data) {
    if (!data || typeof data !== 'object') return null;
    const username = pickClaim(data.preferred_username, data.username, data.login, data.name);
    return normalizeIdentity({
        id: pickClaim(data.sub, data.id, data.user_id, data.userId),
        username,
        displayName: pickClaim(data.name, data.displayName, data.nickname, username),
        email: data.email,
        avatar: pickClaim(data.picture, data.avatar, data.avatar_url),
    });
}

/**
 * Display name of the QRole membership tier (`membership_tier_name` claim), or null.
 * @param {object} claims QRole userinfo response
 * @returns {string|null}
 */
export function getQroleTierName(claims) {
    if (!claims || typeof claims !== 'object') return null;
    return cleanText(claims.membership_tier_name, MAX_TIER_NAME_LENGTH);
}

/**
 * @typedef {Object} QroleRefreshOutcome
 * @property {'ok'|'definitive'|'transient'} kind ok = fresh userinfo obtained; definitive = the
 *   refresh token is no longer accepted; transient = try again later (including a rejected client)
 * @property {string|null} reason Log-safe failure reason (null when ok)
 * @property {string|null} [identityId] QRole user id from the fresh userinfo (ok only)
 * @property {object|null} [claims] Raw userinfo claims (ok only)
 */

/**
 * Classify a failed QRole token endpoint response of the refresh grant.
 * 400 invalid_grant (refresh token expired / revoked / unknown, user banned, client re-created) is
 * definitive for the account's token. invalid_client / 401 (client disabled, deleted or wrong
 * secret, e.g. a rotated secret not yet in config.yaml) is a problem of this site's client, not
 * evidence against the account: it is transient (reason `invalid_client`, tokens are kept, callers
 * treat QRole as unavailable). Everything else (network, timeouts, 429, 5xx, proxies answering
 * with HTML...) is transient as well.
 * @param {JsonRequestResult} result
 * @returns {QroleRefreshOutcome}
 */
export function classifyRefreshFailure(result) {
    if (result.failure === 'http') {
        const error = typeof result.data?.error === 'string' ? result.data.error : '';
        if (result.status === 400 && error === 'invalid_grant') return { kind: 'definitive', reason: 'invalid_grant' };
        if (result.status === 401 || ((result.status === 400) && error === 'invalid_client')) {
            return { kind: 'transient', reason: 'invalid_client' };
        }
        if (result.status === 429) return { kind: 'transient', reason: 'rate_limited' };
        return { kind: 'transient', reason: `http_${result.status}` };
    }
    if (result.failure === 'invalid_url') return { kind: 'transient', reason: 'invalid_url' };
    return { kind: 'transient', reason: result.failure || 'unknown' };
}

/**
 * Use a QRole refresh token: POST the token endpoint with grant_type=refresh_token (same client
 * authentication as the code exchange), then GET userinfo with the new access token.
 * Never throws; tokens are never logged or returned.
 * @param {object} config `oauth.qrole` config
 * @param {string} refreshToken Decrypted refresh token
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [opts] timeoutMs bounds BOTH requests together
 * @returns {Promise<QroleRefreshOutcome>}
 */
export async function refreshQroleIdentity(config, refreshToken, opts = {}) {
    try {
        const signal = AbortSignal.timeout(opts.timeoutMs || 8000);
        const requestOpts = { signal, fetchImpl: opts.fetchImpl, maxBytes: 256 * 1024 };

        const { headers, body } = buildQroleTokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
        const tokenResult = await requestJsonDetailed(getEndpoint('qrole', config, 'tokenUrl'), { method: 'POST', headers, body }, requestOpts);
        if (!tokenResult.ok) return classifyRefreshFailure(tokenResult);

        const accessToken = tokenResult.data?.access_token;
        if (typeof accessToken !== 'string' || !accessToken) {
            return { kind: 'definitive', reason: 'malformed_token_response' };
        }

        const userResult = await requestJsonDetailed(getEndpoint('qrole', config, 'userInfoUrl'), {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
        }, requestOpts);
        if (!userResult.ok) {
            // A freshly issued access token that userinfo refuses is not proof the grant is gone
            const failure = userResult.failure === 'http' ? `userinfo_http_${userResult.status}` : `userinfo_${userResult.failure}`;
            return { kind: 'transient', reason: failure };
        }

        const identity = parseQroleIdentity(userResult.data);
        if (!identity) return { kind: 'transient', reason: 'userinfo_without_id' };
        return { kind: 'ok', reason: null, identityId: identity.id, claims: userResult.data };
    } catch (error) {
        return { kind: 'transient', reason: describeFetchError(error) };
    }
}
