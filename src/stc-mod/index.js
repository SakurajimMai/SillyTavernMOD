// @ts-nocheck
/**
 * SillyTavernchat Module (STC-MOD) - Main Entry Point
 *
 * This is the sidecar module that provides all SillyTavernchat features
 * as a non-invasive add-on to the official SillyTavern.
 *
 * Exports 6 functions called from server-main.js hook points:
 * - configureTrustProxy(app) -> Reverse proxy trust (before cookie-session)
 * - shouldSkipCsrf(req)    -> CSRF exemption check
 * - setupPublicRoutes(app) -> Page routes (before login middleware)
 * - setupPublicApi(app)    -> Public API routes (no auth required)
 * - setupPrivateRoutes(app)-> Private API routes (auth required)
 */
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ensureDefaultConfig, getStcConfig, getStcDataDir } from './config.js';
import { configureTrustProxy as applyTrustProxy } from './middleware/trust-proxy.js';
import { shouldSkipCsrf as csrfCheck } from './middleware/csrf-exemption.js';
import { expirationCheckMiddleware } from './middleware/expiration-check.js';
import { registerStorageEnforceMiddleware } from './middleware/storage-enforce.js';
import { isUserExpired } from './user-metadata.js';

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

/**
 * Hook B: Setup public routes and page overrides.
 * Called BEFORE the official login page route, so our routes take priority.
 * @param {import('express').Express} app
 */
export async function setupPublicRoutes(app) {
    // Serve custom login page (overrides official /login)
    const publicDir = path.join(__dirname, 'public');
    app.get('/login', (req, res, next) => {
        // If user is already logged in, skip to official handler
        if (req.session?.handle) return next();
        return res.sendFile('login.html', { root: publicDir });
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
        return res.sendFile('welcome.html', { root: publicDir });
    });

    // Registration page
    app.get('/register', (req, res) => {
        return res.sendFile('register.html', { root: publicDir });
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
