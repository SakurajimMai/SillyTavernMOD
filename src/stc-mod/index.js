// @ts-nocheck
/**
 * SillyTavernchat Module (STC-MOD) - Main Entry Point
 *
 * This is the sidecar module that provides all SillyTavernchat features
 * as a non-invasive add-on to the official SillyTavern.
 *
 * Exports 5 functions called from server-main.js hook points:
 * - configureTrustProxy(app) -> Reverse proxy trust (before cookie-session)
 * - shouldSkipCsrf(req)    -> CSRF exemption check
 * - setupPublicRoutes(app) -> Password-migration gate, QRole password-login gate,
 *                             QRole session guard, page routes (before official routes
 *                             and login middleware)
 * - setupPublicApi(app)    -> Public API routes (no auth required)
 * - setupPrivateRoutes(app)-> Private API routes (auth required)
 */
import path from 'node:path';
import express from 'express';
import storage from 'node-persist';
import { fileURLToPath } from 'node:url';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { toKey } from '../users.js';
import { getIpAddress, retryAfter } from '../express-common.js';
import { getConfigValue } from '../util.js';
import { DEFAULT_USER } from '../constants.js';
import { ensureDefaultConfig, getStcConfig, getStcDataDir } from './config.js';
import { configureTrustProxy as applyTrustProxy } from './middleware/trust-proxy.js';
import { shouldSkipCsrf as csrfCheck } from './middleware/csrf-exemption.js';
import { expirationCheckMiddleware } from './middleware/expiration-check.js';
import { registerStorageEnforceMiddleware } from './middleware/storage-enforce.js';
import { getUserMeta, isUserExpired } from './user-metadata.js';
import { isRegistrationEnabled } from './services/registration.js';
import { runPasswordMigrationOnce } from './services/password-migration.js';
import { liveMetaForRecord } from './services/account-security.js';
import { qroleSessionGuard } from './services/qrole-session.js';
import { isPasswordLoginAllowed } from './routes/private/set-password.js';
import { sendSitePage } from './services/site-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure default config values on load
ensureDefaultConfig();

// Ensure data directories exist
getStcDataDir();

/**
 * Reverse proxy trust - called from server-main.js before cookie-session
 * @param {import('express').Express} app
 */
export function configureTrustProxy(app) {
    applyTrustProxy(app);
}

/**
 * CSRF exemption check - called from server-main.js skipCsrfProtection
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function shouldSkipCsrf(req) {
    return csrfCheck(req);
}

// Same IP source as the official login rate limiter (users-public.js)
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const TOO_MANY_ATTEMPTS_MESSAGE = '尝试次数过多，请稍后再试';

// Only gate rejections cost a point (successful and ordinary logins are left to the official
// limiter), so the distinct gate messages are not a free account-type oracle
const loginGateLimiter = new RateLimiterMemory({
    points: 30,
    duration: 60,
});

/**
 * Reject a login from one of the STC gates (rate limited per IP).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} message
 */
async function rejectLogin(req, res, message) {
    try {
        await loginGateLimiter.consume(getIpAddress(req, PREFER_REAL_IP_HEADER));
    } catch (rateLimit) {
        if (!(rateLimit instanceof RateLimiterRes)) throw rateLimit;
        return retryAfter(res, rateLimit).status(429).json({ error: TOO_MANY_ATTEMPTS_MESSAGE });
    }
    return res.status(403).json({ error: message });
}

/**
 * Look up the live STC metadata of the account a login targets, exactly like the official login
 * does (`storage.getItem(toKey(request.body.handle))`). Metadata left behind by a deleted account
 * whose handle was re-used is ignored.
 * @param {*} rawHandle `request.body.handle`
 * @returns {Promise<object|null>} Metadata of the account the login targets
 */
async function getLoginTargetMeta(rawHandle) {
    const handle = String(rawHandle);
    const record = await storage.getItem(toKey(handle));
    return liveMetaForRecord(getUserMeta(handle), record);
}

/**
 * The official login hashes `request.body.password` unconditionally for password-protected
 * accounts and answers 500 when it is missing; treat a missing password as empty instead.
 * @type {import('express').RequestHandler}
 */
function defaultMissingPassword(req, res, next) {
    if (req.body && typeof req.body === 'object' && req.body.password === undefined) {
        req.body.password = '';
    }
    return next();
}

/**
 * Block password login (official POST /api/users/login) for QRole member accounts
 * while membership is required, otherwise a password would bypass the VIP check.
 * @type {import('express').RequestHandler}
 */
async function qroleLoginGate(req, res, next) {
    try {
        if (getStcConfig('oauth.qrole.requireMembership', true) === false) return next();

        const rawHandle = req.body?.handle;
        // Let the official handler reject missing handles
        if (rawHandle === undefined || rawHandle === null || rawHandle === '') return next();

        const meta = await getLoginTargetMeta(rawHandle);
        if (isPasswordLoginAllowed(meta)) return next();

        return rejectLogin(req, res, 'QRole 会员账号请使用 QRole 登录');
    } catch (error) {
        console.error('[STC-MOD] QRole login gate error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * Block handle-only login: the official login skips the password check for accounts without a
 * password, so anybody knowing the handle could enter them. default-user is exempt (first-run
 * setup logs in with it before a password is set). Blocked users get a password from an admin
 * (official user management) or through the official "忘记密码" recovery code.
 * @type {import('express').RequestHandler}
 */
async function passwordlessLoginGate(req, res, next) {
    try {
        const rawHandle = req.body?.handle;
        // Let the official handler reject missing handles
        if (rawHandle === undefined || rawHandle === null || rawHandle === '') return next();

        // Same lookup as the official login: storage.getItem(toKey(request.body.handle))
        const record = await storage.getItem(toKey(String(rawHandle)));
        if (!record || record.enabled === false || record.password || record.handle === DEFAULT_USER.handle) {
            return next();
        }

        return rejectLogin(req, res, '该账号尚未设置密码，为保护账号安全已禁止仅凭用户名登录，请联系管理员设置密码');
    } catch (error) {
        console.error('[STC-MOD] Passwordless login gate error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * Hook B: Setup public routes and page overrides.
 * Called BEFORE the official login page route, so our routes take priority.
 * @param {import('express').Express} app
 */
export async function setupPublicRoutes(app) {
    // Hold requests until passwordless OAuth accounts have been secured (runs once;
    // node-persist is initialized before the server accepts requests). The migration
    // promise never rejects; either way the request continues.
    let passwordMigrationDone = false;
    app.use((req, res, next) => {
        if (passwordMigrationDone) return next();
        const proceed = () => {
            passwordMigrationDone = true;
            next();
        };
        runPasswordMigrationOnce().then(proceed, proceed).catch((error) => {
            console.error('[STC-MOD] Request failed after password migration gate:', error);
        });
    });

    // Login gates (run before the official /api/users/login): QRole VIP accounts must use QRole,
    // and accounts without a password cannot be entered by handle alone.
    // Mounted as a router like the official usersPublicRouter so that every path variant the
    // official route accepts (//login, /LOGIN/, trailing slash...) goes through the gate too.
    const loginGate = express.Router();
    loginGate.post('/login', defaultMissingPassword, qroleLoginGate, passwordlessLoginGate);
    app.use('/api/users', loginGate);

    // End sessions of QRole accounts whose membership lapsed or must be re-verified
    // (setUserDataMiddleware already ran, so req.user is set)
    app.use(qroleSessionGuard);

    // Serve custom login page (overrides official /login)
    // Pages are rendered with the config.yaml `site` settings (falls back to the static file)
    const publicDir = path.join(__dirname, 'public');
    app.get('/login', (req, res, next) => {
        // If user is already logged in, skip to official handler
        if (req.session?.handle) return next();
        return sendSitePage(res, 'login.html', 'login').catch(next);
    });

    // Welcome page (+ expiry enforcement for logged-in users)
    app.get('/', (req, res, next) => {
        if (req.session?.handle) {
            // If invitation code system is enabled, kick expired users back to login
            if (getStcConfig('enableInvitationCodes', false) && isUserExpired(req.session.handle)) {
                const handle = req.session.handle;
                req.session = null; // destroy session
                return res.redirect(`/login?reason=expired&handle=${encodeURIComponent(handle)}`);
            }
            return next();
        }
        return sendSitePage(res, 'welcome.html', 'welcome').catch(next);
    });

    // Registration page (redirect to login when registration is closed)
    app.get('/register', (req, res, next) => {
        if (!isRegistrationEnabled()) {
            return res.redirect('/login?notice=registration_closed');
        }
        return sendSitePage(res, 'register.html', 'register').catch(next);
    });

    // Serve STC-MOD static assets
    app.use('/stc-assets', express.static(publicDir, { maxAge: '1d' }));

    // Storage quota enforcement – intercepts write operations before official handlers
    registerStorageEnforceMiddleware(app);

    console.log('[STC-MOD] Public routes registered.');
}

/**
 * Hook D: Setup public API routes (no authentication required).
 * Called AFTER usersPublicRouter but BEFORE requireLoginMiddleware.
 * @param {import('express').Express} app
 */
export async function setupPublicApi(app) {
    // OAuth routes
    const { router: oauthRouter } = await import('./routes/public/oauth.js');
    app.use('/api/stc/oauth', oauthRouter);

    // Registration route (calls official API internally)
    const { router: registerRouter } = await import('./routes/public/register.js');
    app.use('/api/stc/users', registerRouter);

    // Invitation codes public status
    const { router: invitationStatusRouter } = await import('./routes/public/invitation-status.js');
    app.use('/api/stc/invitation-codes', invitationStatusRouter);

    // Login page announcements
    const { router: announcementsPublicRouter } = await import('./routes/public/announcements-public.js');
    app.use('/api/stc/announcements', announcementsPublicRouter);

    // Email service status
    const { router: emailStatusRouter } = await import('./routes/public/email-status.js');
    app.use('/api/stc/email', emailStatusRouter);

    // Public config (for frontend to query enabled features)
    const { router: publicConfigRouter } = await import('./routes/public/public-config.js');
    app.use('/api/stc/public-config', publicConfigRouter);

    console.log('[STC-MOD] Public API routes registered.');
}

/**
 * Hook E: Setup private API routes (authentication required).
 * Called AFTER setupPrivateEndpoints.
 * @param {import('express').Express} app
 */
export async function setupPrivateRoutes(app) {
    // User expiration check middleware for all STC private routes
    app.use('/api/stc', expirationCheckMiddleware);

    // Invitation codes management (admin)
    const { router: invitationCodesRouter } = await import('./routes/private/invitation-codes.js');
    app.use('/api/stc/invitation-codes', invitationCodesRouter);

    // Extended user endpoints (renew, profile, etc.)
    const { router: userExtendRouter } = await import('./routes/private/user-extend.js');
    app.use('/api/stc/users', userExtendRouter);

    // Announcements management (admin)
    const { router: announcementsRouter } = await import('./routes/private/announcements.js');
    app.use('/api/stc/announcements', announcementsRouter);

    // Email configuration (admin)
    const { router: emailConfigRouter } = await import('./routes/private/email-config.js');
    app.use('/api/stc/email-config', emailConfigRouter);

    // OAuth configuration (admin)
    const { router: oauthConfigRouter } = await import('./routes/private/oauth-config.js');
    app.use('/api/stc/oauth-config', oauthConfigRouter);

    // Registration switch (admin)
    const { router: registrationConfigRouter } = await import('./routes/private/registration-config.js');
    app.use('/api/stc/registration-config', registrationConfigRouter);

    // System monitoring (admin)
    const { router: systemLoadRouter } = await import('./routes/private/system-load.js');
    app.use('/api/stc/system-load', systemLoadRouter);

    // User storage management
    const { router: userStorageRouter } = await import('./routes/private/user-storage.js');
    app.use('/api/stc/user-storage', userStorageRouter);

    // Default config template (admin)
    const { router: defaultConfigRouter } = await import('./routes/private/default-config.js');
    app.use('/api/stc/default-config', defaultConfigRouter);

    // Scheduled tasks (admin)
    const { router: scheduledTasksRouter } = await import('./routes/private/scheduled-tasks.js');
    app.use('/api/stc/scheduled-tasks', scheduledTasksRouter);

    // Privacy vault (user API keys)
    const { router: privacyVaultRouter } = await import('./routes/private/privacy-vault.js');
    app.use('/api/stc/privacy-vault', privacyVaultRouter);

    // Password management (user)
    const { router: setPasswordRouter } = await import('./routes/private/set-password.js');
    app.use('/api/stc/users', setPasswordRouter);

    console.log('[STC-MOD] Private API routes registered.');
}
