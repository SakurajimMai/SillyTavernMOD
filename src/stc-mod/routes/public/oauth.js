/**
 * SillyTavernchat Module - OAuth Routes
 * Handles GitHub, Discord, Linux.do and QRole OAuth login/registration.
 *
 * Flow integrity: the state (and the QRole PKCE verifier) is bound to the browser session,
 * single use and valid for 10 minutes. An identity waiting for an invitation code is kept
 * server-side in the session, never round-tripped through the browser. Every callback failure
 * redirects to /login?oauth_error=<fixed code>.
 */
import express from 'express';
import crypto from 'node:crypto';
import storage from 'node-persist';
import { getStcConfig } from '../../config.js';
import { toKey, getAccountVersion } from '../../../users.js';
import { findUserByOAuth, getUserMeta, setUserMeta, recordLogin } from '../../user-metadata.js';
import { createOAuthUser, rollbackCreatedUser } from './register-helper.js';
import * as invitationService from '../../services/invitation-codes.js';
import { isRegistrationEnabled, sendRegistrationClosed } from '../../services/registration.js';
import { OAUTH_PROVIDERS, isMetaForRecord } from '../../services/account-security.js';
import { evaluateQroleMembership, describeClaimKeys } from '../../services/qrole-membership.js';

export const router = express.Router();

// Lifetime of an authorize request (state/PKCE) and of a pending invite-code registration
const FLOW_TTL_MS = 10 * 60 * 1000;
// Timeout for every request to the OAuth provider
const FETCH_TIMEOUT_MS = 15 * 1000;
const MAX_LINK_CLEANUPS = 10;

const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const MAX_AVATAR_LENGTH = 512;

const PENDING_EXPIRED_MESSAGE = '登录状态已失效，请重新使用第三方账号登录';
const ALREADY_LINKED_MESSAGE = '该第三方账号已绑定其他账户';

/** Codes the login page understands; anything else is reported as server_error. */
const OAUTH_ERROR_CODES = new Set([
    'denied',
    'invalid_state',
    'provider_disabled',
    'token_failed',
    'userinfo_failed',
    'not_member',
    'membership_expired',
    'membership_unknown',
    'account_suspended',
    'account_disabled',
    'registration_closed',
    'create_failed',
    'server_error',
]);

/** Built-in endpoints. Only linuxdo and qrole may override the URLs from config. */
const PROVIDER_DEFAULTS = {
    github: {
        authUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
        scope: 'read:user user:email',
    },
    discord: {
        authUrl: 'https://discord.com/api/oauth2/authorize',
        tokenUrl: 'https://discord.com/api/oauth2/token',
        userInfoUrl: 'https://discord.com/api/users/@me',
        scope: 'identify email',
    },
    linuxdo: {
        authUrl: 'https://connect.linux.do/oauth2/authorize',
        tokenUrl: 'https://connect.linux.do/oauth2/token',
        userInfoUrl: 'https://connect.linux.do/api/user',
        scope: '',
    },
    qrole: {
        authUrl: 'https://www.qqy.one/api/oauth/authorize',
        tokenUrl: 'https://www.qqy.one/api/oauth/token',
        userInfoUrl: 'https://www.qqy.one/api/oauth/userinfo',
        scope: 'openid profile email',
    },
};

/**
 * Redirect to the login page with a fixed error code (never free text).
 * @param {import('express').Response} res
 * @param {string} code One of OAUTH_ERROR_CODES
 */
function redirectOauthError(res, code) {
    const safeCode = OAUTH_ERROR_CODES.has(code) ? code : 'server_error';
    return res.redirect('/login?oauth_error=' + encodeURIComponent(safeCode));
}

/**
 * Read a config value as a trimmed string (YAML may turn numeric client ids into numbers).
 * @param {*} value
 * @returns {string}
 */
function configString(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

/**
 * Config of a known, enabled provider with a client id, or null.
 * @param {string} provider
 * @returns {object|null}
 */
function getEnabledProviderConfig(provider) {
    if (!OAUTH_PROVIDERS.includes(provider)) return null;
    const config = getStcConfig(`oauth.${provider}`, null);
    if (!config || typeof config !== 'object' || !config.enabled) return null;
    if (!configString(config.clientId)) return null;
    return config;
}

/**
 * Provider endpoint URL (authUrl / tokenUrl / userInfoUrl).
 * @param {string} provider
 * @param {object} config
 * @param {'authUrl'|'tokenUrl'|'userInfoUrl'} key
 * @returns {string}
 */
function getEndpoint(provider, config, key) {
    if (provider === 'linuxdo' || provider === 'qrole') {
        const configured = configString(config[key]);
        if (configured) return configured;
    }
    return PROVIDER_DEFAULTS[provider][key];
}

/**
 * Scope requested at the authorize endpoint ('' = none).
 * @param {string} provider
 * @param {object} config
 * @returns {string}
 */
function getScope(provider, config) {
    if (provider === 'qrole') return configString(config.scope) || PROVIDER_DEFAULTS.qrole.scope;
    if (provider === 'linuxdo') return configString(config.scope);
    return PROVIDER_DEFAULTS[provider].scope;
}

/**
 * Callback URL registered with the provider. Express resolves req.protocol according to the
 * trust proxy setting; forwarded headers are never read directly.
 * @param {import('express').Request} req
 * @param {string} provider
 * @returns {string}
 */
function getCallbackUrl(req, provider) {
    const configured = configString(getStcConfig(`oauth.${provider}.callbackUrl`, ''));
    if (configured) return configured;
    return `${req.protocol}://${req.get('host')}/api/stc/oauth/${provider}/callback`;
}

/**
 * Build the provider authorize URL.
 * @param {string} provider
 * @param {object} config
 * @param {string} callbackUrl
 * @param {string} state
 * @param {string|null} verifier PKCE code verifier (null = no PKCE)
 * @returns {string}
 */
function buildAuthorizeUrl(provider, config, callbackUrl, state, verifier) {
    const url = new URL(getEndpoint(provider, config, 'authUrl'));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('authUrl must be an http(s) URL');
    }
    url.searchParams.set('client_id', configString(config.clientId));
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    const scope = getScope(provider, config);
    if (scope) url.searchParams.set('scope', scope);
    if (verifier) {
        url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
        url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
}

/**
 * Whether a session entry was created less than FLOW_TTL_MS ago.
 * @param {{createdAt?: number}|null|undefined} entry
 * @returns {boolean}
 */
function isFresh(entry) {
    return !!entry && typeof entry.createdAt === 'number' && Date.now() - entry.createdAt <= FLOW_TTL_MS;
}

/**
 * Constant-time string comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validate the authorize request stored in the session against the callback.
 * @param {*} flow req.session.stcOauth (already consumed)
 * @param {string} provider Provider from the callback URL
 * @param {*} state state query parameter
 * @returns {boolean}
 */
function isValidFlow(flow, provider, state) {
    if (!flow || typeof flow !== 'object') return false;
    if (flow.provider !== provider || !isFresh(flow)) return false;
    if (typeof state !== 'string' || !state || typeof flow.state !== 'string') return false;
    return safeEqual(state, flow.state);
}

/**
 * Valid pending (invite-code) registration from the session, or null.
 * A QRole identity only goes through this flow while the membership gate is off; once
 * requireMembership is on again, its pending entry is void (it was never membership-checked).
 * @param {import('express').Request} req
 * @returns {{provider: string, id: string, username: string|null, displayName: string|null, email: string|null, avatar: string|null, membership?: {tier: string|null, expiresAt: number|null}|null, createdAt: number}|null}
 */
function getPendingRegistration(req) {
    const pending = req.session?.stcOauthPending;
    if (!pending || typeof pending !== 'object') return null;
    const qroleGated = pending.provider === 'qrole' && getStcConfig('oauth.qrole.requireMembership', true) !== false;
    if (!isFresh(pending) || qroleGated) {
        req.session.stcOauthPending = null;
        return null;
    }
    if (!OAUTH_PROVIDERS.includes(pending.provider)) return null;
    if (typeof pending.id !== 'string' || !pending.id) return null;
    return pending;
}

/**
 * QRole membership snapshot ({tier, expiresAt}) kept with a pending registration, or null.
 * @param {*} value Evaluation result or stored snapshot
 * @returns {{tier: string|null, expiresAt: number|null}|null}
 */
function toMembershipSnapshot(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        tier: typeof value.tier === 'string' && value.tier ? value.tier : null,
        expiresAt: typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : null,
    };
}

/**
 * Metadata recording a QRole membership snapshot on a new account, or undefined.
 * @param {{tier: string|null, expiresAt: number|null}|null} membership
 * @returns {object|undefined}
 */
function membershipMeta(membership) {
    return membership
        ? { qroleTier: membership.tier, qroleMembershipExpiresAt: membership.expiresAt }
        : undefined;
}

/**
 * Describe a fetch failure without echoing anything that could contain secrets.
 * @param {*} error
 * @returns {string}
 */
function describeFetchError(error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
    return String(error?.cause?.code || error?.name || 'network error');
}

/**
 * Request JSON from the provider. Never throws; failures are logged (status only) and yield null.
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} label Log label, e.g. 'github token'
 * @returns {Promise<object|null>}
 */
async function requestJson(url, init, label) {
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        console.warn(`[STC-MOD] OAuth ${label} URL is invalid`);
        return null;
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        console.warn(`[STC-MOD] OAuth ${label} URL must be http(s)`);
        return null;
    }

    let resp;
    try {
        resp = await fetch(parsedUrl, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
        console.warn(`[STC-MOD] OAuth ${label} request failed: ${describeFetchError(error)}`);
        return null;
    }

    if (!resp.ok) {
        console.warn(`[STC-MOD] OAuth ${label} request failed: HTTP ${resp.status}`);
        await resp.body?.cancel().catch(() => {});
        return null;
    }

    try {
        const data = await resp.json();
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {
        // Parse errors may quote the body (tokens); do not log them
    }
    console.warn(`[STC-MOD] OAuth ${label} response is not a JSON object`);
    return null;
}

/**
 * Exchange the authorization code for an access token.
 * @param {string} provider
 * @param {object} config
 * @param {string} code
 * @param {string} callbackUrl
 * @param {string|null} verifier PKCE code verifier
 * @returns {Promise<string|null>} Access token, or null on failure
 */
async function exchangeCode(provider, config, code, callbackUrl, verifier) {
    const clientId = configString(config.clientId);
    const clientSecret = configString(config.clientSecret);
    const tokenUrl = getEndpoint(provider, config, 'tokenUrl');
    let headers, body;

    switch (provider) {
        case 'github':
            headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            body = JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl });
            break;
        case 'discord':
        case 'linuxdo':
            headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
            body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: callbackUrl }).toString();
            break;
        case 'qrole': {
            headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
            const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl });
            if (config.tokenAuthMethod === 'client_secret_basic') {
                const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
                headers['Authorization'] = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
            } else {
                params.set('client_id', clientId);
                if (clientSecret) params.set('client_secret', clientSecret);
            }
            if (verifier) params.set('code_verifier', verifier);
            body = params.toString();
            break;
        }
        default:
            return null;
    }

    const data = await requestJson(tokenUrl, { method: 'POST', headers, body }, `${provider} token`);
    if (!data) return null;
    if (typeof data.access_token !== 'string' || !data.access_token) {
        console.warn(`[STC-MOD] OAuth ${provider} token response has no access_token`);
        return null;
    }
    return data.access_token;
}

/**
 * First value that is a non-empty string or a finite number.
 * @param {...*} values
 * @returns {string|number|undefined}
 */
function pickClaim(...values) {
    return values.find(value => (typeof value === 'string' && value.trim() !== '') || (typeof value === 'number' && Number.isFinite(value)));
}

/**
 * Printable, trimmed, length-limited text, or null.
 * @param {*} value
 * @param {number} maxLength
 * @returns {string|null}
 */
function cleanText(value, maxLength) {
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
 * Normalize a provider identity. Returns null when there is no usable user id.
 * @param {{id: *, username: *, displayName: *, email: *, avatar: *}} raw
 * @returns {{id: string, username: string|null, displayName: string|null, email: string|null, avatar: string|null}|null}
 */
function normalizeIdentity({ id, username, displayName, email, avatar }) {
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
 * Fetch and normalize the user identity (server-to-server userinfo call, never a token payload).
 * @param {string} provider
 * @param {object} config
 * @param {string} token Access token
 * @returns {Promise<{id: string, username: string|null, displayName: string|null, email: string|null, avatar: string|null, claims?: object}|null>}
 */
async function fetchIdentity(provider, config, token) {
    const bearerHeaders = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };

    switch (provider) {
        case 'github': {
            const data = await requestJson(getEndpoint(provider, config, 'userInfoUrl'), {
                headers: { 'Authorization': `token ${token}`, 'Accept': 'application/json', 'User-Agent': 'SillyTavern' },
            }, 'github userinfo');
            if (!data) return null;
            return normalizeIdentity({ id: data.id, username: data.login, displayName: data.name, email: data.email, avatar: data.avatar_url });
        }
        case 'discord': {
            const data = await requestJson(getEndpoint(provider, config, 'userInfoUrl'), { headers: bearerHeaders }, 'discord userinfo');
            if (!data) return null;
            const avatar = typeof data.avatar === 'string' && data.avatar && typeof data.id === 'string'
                ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(data.id)}/${encodeURIComponent(data.avatar)}.png`
                : null;
            return normalizeIdentity({ id: data.id, username: data.username, displayName: data.global_name, email: data.email, avatar });
        }
        case 'linuxdo': {
            const data = await requestJson(getEndpoint(provider, config, 'userInfoUrl'), { headers: bearerHeaders }, 'linuxdo userinfo');
            if (!data) return null;
            const user = data.user && typeof data.user === 'object' ? data.user : data;
            return normalizeIdentity({
                id: pickClaim(user.id, user.sub),
                username: pickClaim(user.username, user.login, user.preferred_username, user.name),
                displayName: pickClaim(user.name, user.username),
                email: user.email,
                avatar: user.avatar_url,
            });
        }
        case 'qrole': {
            const data = await requestJson(getEndpoint(provider, config, 'userInfoUrl'), { headers: bearerHeaders }, 'qrole userinfo');
            if (!data) return null;
            const username = pickClaim(data.preferred_username, data.username, data.login, data.name);
            const identity = normalizeIdentity({
                id: pickClaim(data.sub, data.id, data.user_id, data.userId),
                username,
                displayName: pickClaim(data.name, data.displayName, data.nickname, username),
                email: data.email,
                avatar: pickClaim(data.picture, data.avatar, data.avatar_url),
            });
            // Raw claims are needed for the membership check; the QRole `role` claim is never used
            return identity ? { ...identity, claims: data } : null;
        }
        default:
            return null;
    }
}

/**
 * Find the live account linked to an OAuth identity. Links pointing at deleted accounts (or at a
 * different account that re-used the handle) are cleared on the way.
 * @param {string} provider
 * @param {string} id
 * @returns {Promise<{handle: string, record: object}|null>}
 */
async function resolveLinkedAccount(provider, id) {
    for (let i = 0; i < MAX_LINK_CLEANUPS; i++) {
        const handle = findUserByOAuth(provider, id);
        if (!handle) return null;

        const record = await storage.getItem(toKey(handle));
        if (record && isMetaForRecord(getUserMeta(handle), record)) {
            return { handle, record };
        }

        console.warn(`[STC-MOD] Clearing stale ${provider} OAuth link on handle`, handle);
        setUserMeta(handle, { oauthProvider: null, oauthUserId: null }, { immediate: true });
    }
    return null;
}

/**
 * Log the user in (same session fields as the official login) and record the login.
 * @param {import('express').Request} req
 * @param {string} handle
 * @param {object} userRecord Official user record
 * @param {{tier: string|null, expiresAt: number|null}|null} [membership] QRole membership snapshot
 */
function loginSession(req, handle, userRecord, membership = null) {
    req.session.handle = handle;
    req.session.version = getAccountVersion(userRecord);
    req.session.stcOauthPending = null;
    if (membership) {
        setUserMeta(handle, {
            qroleTier: membership.tier,
            qroleMembershipExpiresAt: membership.expiresAt,
            qroleCheckedAt: Date.now(),
        });
    }
    recordLogin(handle);
}

// NOTE: /pending and /complete-registration must be declared before /:provider

// Identity waiting for an invitation code (read by register.html)
router.get('/pending', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const pending = getPendingRegistration(req);
    if (!pending) return res.status(404).json({ error: 'no_pending' });
    return res.json({
        provider: pending.provider,
        username: pending.username || null,
        displayName: pending.displayName || null,
    });
});

// Complete OAuth registration with invite code. The identity comes from the session only.
router.post('/complete-registration', async (req, res) => {
    try {
        if (!isRegistrationEnabled()) {
            return sendRegistrationClosed(res);
        }

        // A QRole entry is void here if requireMembership was switched on since the callback
        const pending = getPendingRegistration(req);
        if (!pending || !getEnabledProviderConfig(pending.provider)) {
            return res.status(400).json({ error: PENDING_EXPIRED_MESSAGE });
        }
        const membership = pending.provider === 'qrole' ? toMembershipSnapshot(pending.membership) : null;

        const invitationEnabled = invitationService.isEnabled();
        const inviteCode = typeof req.body?.inviteCode === 'string' ? req.body.inviteCode.trim() : '';
        if (invitationEnabled) {
            if (!inviteCode) return res.status(400).json({ error: '需要邀请码' });
            const validation = invitationService.validateInvitationCode(inviteCode);
            if (!validation.valid) return res.status(400).json({ error: validation.reason || '邀请码无效' });
        }

        if (await resolveLinkedAccount(pending.provider, pending.id)) {
            return res.status(409).json({ error: ALREADY_LINKED_MESSAGE });
        }

        const result = await createOAuthUser({
            provider: pending.provider,
            id: pending.id,
            username: pending.username,
            displayName: pending.displayName,
            email: pending.email,
            avatar: pending.avatar,
            extraMeta: membershipMeta(membership),
        });
        if (!result.success) {
            return res.status(result.conflict ? 409 : 400).json({ error: result.error || '创建用户失败' });
        }

        const userHandle = String(result.handle);

        // The metadata exists now, so time-limited codes get a real expiry (not permanent)
        if (invitationEnabled) {
            const useResult = invitationService.useInvitationCode(inviteCode, userHandle);
            if (!useResult.success) {
                // e.g. the same code was consumed concurrently: do not keep an account without it
                await rollbackCreatedUser(userHandle);
                return res.status(400).json({ error: useResult.reason || '邀请码使用失败' });
            }
            setUserMeta(userHandle, {
                expiresAt: useResult.expiresAt ?? 0,
                inviteCodeUsed: inviteCode.toUpperCase(),
            }, { immediate: true });
        }

        const record = await storage.getItem(toKey(userHandle));
        if (!record) {
            return res.status(500).json({ error: '注册失败' });
        }

        req.session.stcOauthPending = null;
        loginSession(req, userHandle, record, membership);

        return res.json({ success: true, handle: userHandle });
    } catch (error) {
        console.error('[STC-MOD] Complete OAuth registration error:', error);
        return res.status(500).json({ error: '注册失败' });
    }
});

// Initiate OAuth flow
router.get('/:provider', (req, res) => {
    const provider = String(req.params.provider || '');
    const config = getEnabledProviderConfig(provider);
    if (!config) return res.status(404).json({ error: 'OAuth provider not enabled' });
    if (!req.session) return redirectOauthError(res, 'server_error');

    try {
        const state = crypto.randomBytes(32).toString('hex');
        const verifier = provider === 'qrole' && config.usePkce !== false
            ? crypto.randomBytes(32).toString('base64url')
            : null;
        const authUrl = buildAuthorizeUrl(provider, config, getCallbackUrl(req, provider), state, verifier);

        // Overwrites any previous (unfinished) authorize request of this browser
        req.session.stcOauth = { state, provider, verifier, createdAt: Date.now() };
        return res.redirect(authUrl);
    } catch (error) {
        console.error(`[STC-MOD] OAuth ${provider} authorize error:`, error?.message);
        return redirectOauthError(res, 'server_error');
    }
});

// OAuth callback
router.get('/:provider/callback', async (req, res) => {
    const provider = String(req.params.provider || '');
    const logLabel = OAUTH_PROVIDERS.includes(provider) ? provider : 'unknown';

    // Single use: consume the authorize request before anything else
    const flow = req.session?.stcOauth;
    if (req.session) req.session.stcOauth = null;

    try {
        if (req.query.error) {
            return redirectOauthError(res, 'denied');
        }

        if (!isValidFlow(flow, provider, req.query.state)) {
            return redirectOauthError(res, 'invalid_state');
        }

        const config = getEnabledProviderConfig(provider);
        if (!config) {
            return redirectOauthError(res, 'provider_disabled');
        }

        const code = typeof req.query.code === 'string' ? req.query.code : '';
        if (!code) {
            return redirectOauthError(res, 'invalid_state');
        }

        const callbackUrl = getCallbackUrl(req, provider);
        const accessToken = await exchangeCode(provider, config, code, callbackUrl, flow.verifier || null);
        if (!accessToken) {
            return redirectOauthError(res, 'token_failed');
        }

        const identity = await fetchIdentity(provider, config, accessToken);
        if (!identity) {
            return redirectOauthError(res, 'userinfo_failed');
        }

        // QRole: checked on every login, new and existing accounts alike
        let membership = null;
        if (provider === 'qrole') {
            membership = evaluateQroleMembership(identity.claims, config);
            if (!membership.allowed) {
                if (membership.code === 'membership_unknown') {
                    console.warn(`[STC-MOD] QRole membership could not be determined; check oauth.qrole.tierClaims/expiryClaims. Userinfo claim keys: ${describeClaimKeys(identity.claims)}`);
                } else {
                    console.info(`[STC-MOD] QRole login denied: ${membership.code}`);
                }
                return redirectOauthError(res, membership.code);
            }
        }

        // Existing link
        const linked = await resolveLinkedAccount(provider, identity.id);
        if (linked) {
            if (linked.record.enabled === false) {
                return redirectOauthError(res, 'account_disabled');
            }
            loginSession(req, linked.handle, linked.record, membership);
            return res.redirect('/');
        }

        // New identity. Verified QRole members are provisioned even when registration is closed and
        // without an invitation code. With requireMembership off, QRole is an ordinary provider.
        const memberBypass = provider === 'qrole' && config.requireMembership !== false;
        if (!memberBypass) {
            if (!isRegistrationEnabled()) {
                return redirectOauthError(res, 'registration_closed');
            }
            if (invitationService.isEnabled()) {
                // Keep the identity server-side until an invitation code is entered
                req.session.stcOauthPending = {
                    provider,
                    id: identity.id,
                    username: identity.username,
                    displayName: identity.displayName,
                    email: identity.email,
                    avatar: identity.avatar,
                    membership: toMembershipSnapshot(membership),
                    createdAt: Date.now(),
                };
                return res.redirect('/register?oauth=pending');
            }
        }

        const result = await createOAuthUser({
            provider,
            id: identity.id,
            username: identity.username,
            displayName: identity.displayName,
            email: identity.email,
            avatar: identity.avatar,
            extraMeta: membershipMeta(toMembershipSnapshot(membership)),
        });
        if (!result.success) {
            return redirectOauthError(res, 'create_failed');
        }

        const userHandle = String(result.handle);
        const record = await storage.getItem(toKey(userHandle));
        if (!record) {
            return redirectOauthError(res, 'create_failed');
        }

        loginSession(req, userHandle, record, membership);
        return res.redirect('/');
    } catch (error) {
        console.error(`[STC-MOD] OAuth ${logLabel} callback error:`, error);
        return redirectOauthError(res, 'server_error');
    }
});
