/**
 * SillyTavernchat Module - Data root write guard
 *
 * Answers every data-changing request (POST / PUT / PATCH / DELETE, any path) with 503
 * STORE_UNAVAILABLE while the data root is unavailable (lost, broken or hanging mount, see
 * services/json-store.js). The official handlers (chat / world info / settings saves, uploads,
 * deletions, ...) have no such check and would otherwise write into the empty directory under a
 * lost mount before the watchdog restarts the process. Installed twice:
 * - first in setupPublicRoutes, in front of every official and STC router;
 * - again right after the official upload middleware (multer + multerMonkeyPatch in server-main.js),
 *   i.e. after a multipart body has been received and after the awaiting STC middlewares, so a loss
 *   during a long upload or a slow STC check is still caught before the official handler runs.
 *
 * Costs one stat of the data root per data-changing request (none when the data root is not on its
 * own mount, and none once the guard already knows the mount is gone or hanging). Reads (GET / HEAD /
 * OPTIONS) are not affected: they cannot damage data. Logout writes nothing and stays possible.
 */
import { assertDataRootAvailable, isStoreUnavailableError, sendStoreUnavailable } from '../services/json-store.js';

/** Methods that can change data. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Data-changing requests that write nothing to the data root (the session lives in the cookie). */
const EXEMPT_PATHS = new Set(['/api/users/logout']);

/**
 * Whether the request can change data on the data root.
 * @param {string} method HTTP method
 * @param {string} requestPath req.path
 * @returns {boolean}
 */
export function isGuardedRequest(method, requestPath) {
    if (!WRITE_METHODS.has(String(method || '').toUpperCase())) return false;
    const normalized = String(requestPath || '').toLowerCase().replace(/\/+/g, '/').replace(/\/$/, '');
    return !EXEMPT_PATHS.has(normalized);
}

/**
 * Create the guard middleware.
 * @param {object} [deps] Injectable for tests
 * @param {() => void} [deps.assertAvailable] Throws StoreUnavailableError while the data root is unavailable
 * @returns {import('express').RequestHandler}
 */
export function createDataRootWriteGuard({ assertAvailable = assertDataRootAvailable } = {}) {
    return function dataRootWriteGuard(req, res, next) {
        if (!isGuardedRequest(req.method, req.path)) return next();
        try {
            assertAvailable();
        } catch (error) {
            if (isStoreUnavailableError(error)) return sendStoreUnavailable(req, res);
            // An unexpected guard failure must not take the whole API down
            console.error('[STC-MOD] Data root write guard error:', /** @type {any} */ (error)?.message || error);
        }
        return next();
    };
}

/**
 * Register `middleware` on `app` right after the next `app.use(...)` call that registers `marker`
 * (e.g. the official multerMonkeyPatch, which server-main.js registers after the STC public-route
 * hook and right before the official routers). Only public Express API is used: `app.use` is wrapped
 * on the instance until the marker shows up, then restored.
 * @param {import('express').Express} app
 * @param {Function} marker Middleware function to look for (same reference as server-main.js uses)
 * @param {import('express').RequestHandler} middleware Middleware to add right after it
 * @returns {{ installed: () => boolean, restore: () => void }} `restore` undoes the wrapper if the marker never came
 */
export function useRightAfter(app, marker, middleware) {
    const hadOwnUse = Object.prototype.hasOwnProperty.call(app, 'use');
    const ownUse = app.use;
    let installed = false;
    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        if (hadOwnUse) app.use = ownUse;
        else delete app.use;
    };
    app.use = function useWithGuard(...args) {
        const result = ownUse.apply(this, args);
        if (!installed && args.includes(marker)) {
            installed = true;
            restore();
            ownUse.call(this, middleware);
        }
        return result;
    };
    return { installed: () => installed, restore };
}
