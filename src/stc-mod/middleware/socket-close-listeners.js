/**
 * SillyTavernchat Module - Keep Node's own 'close' listeners on client sockets
 *
 * About 20 official generation handlers (chat / text completions, Google, Horde, KoboldAI, NovelAI,
 * image generation, ...) do
 *
 *     request.socket.removeAllListeners('close');
 *     request.socket.on('close', () => controller.abort());
 *
 * to drop the abort listeners that earlier requests left on a keep-alive socket. That also removes
 * the listeners Node's HTTP(S) server itself put there (the per-connection `socketOnClose`, which
 * frees the parser and so takes the socket off the server's connection list, `onServerResponseClose`
 * of the current response, and on TLS sockets `onSocketClose` / `onSocketCloseDestroySSL`). Such a
 * socket stays referenced after the client disconnected, together with everything its remaining
 * listeners hold (request, response, parsed body with the whole prompt, upstream response):
 * 0.2-0.3 MB per generation that is never freed.
 *
 * Fix (no official file changes): the middleware runs first in setupPublicRoutes, in front of every
 * official router, and patches each client socket once (symbol-marked, idempotent).
 * - When the first request of a socket reaches the middleware, no application code has run for that
 *   socket yet (every official handler runs after this middleware), so all its 'close' listeners were
 *   added by Node (plus the official pre-router middlewares, which add none in the normal path;
 *   on-finished closures on error paths remove themselves). These listener functions are recorded as
 *   internal (WeakSet, nothing is retained).
 * - The socket's `removeAllListeners('close')` then removes only listeners that are not internal:
 *   the abort / forwarding listeners of earlier requests on the same keep-alive socket still go away
 *   (the official intent), Node's own stay. Node re-adds the same `onServerResponseClose` function for
 *   every response, so it is recognised again on later requests of the socket; a listener function
 *   first seen after the snapshot is always treated as an application listener, so a snapshot per
 *   request is not needed (it could not tell an earlier request's leftover abort listener from Node's).
 * - Listeners are removed one by one (last first, like EventEmitter#removeAllListeners does), so the
 *   kept listeners keep their order and `once` wrappers, and 'removeListener' is emitted exactly for
 *   the removed ones.
 * Everything else behaves as before: other events, `removeAllListeners()` without an argument,
 * calls on other objects, and sockets that left the HTTP parser (upgraded or closed: Node nulls
 * `socket.parser`) use the original method. Requests without a socket are passed through.
 */

/** Per-socket state; the property is non-enumerable. */
const STATE = Symbol.for('stc-mod.socketCloseListeners');

/**
 * Whether the socket's `removeAllListeners('close')` is already patched.
 * @param {any} socket
 * @returns {boolean}
 */
export function isSocketProtected(socket) {
    return Boolean(socket && typeof socket === 'object' && Object.prototype.hasOwnProperty.call(socket, STATE));
}

/**
 * Record the socket's current 'close' listeners as internal and patch its
 * `removeAllListeners('close')` to keep them. Must run before any application code touched the
 * socket's 'close' listeners (the first request of the socket, before the official routers).
 * Idempotent: later calls on the same socket change nothing.
 * @param {any} socket Client socket (`req.socket`, net.Socket or tls.TLSSocket)
 * @returns {boolean} Whether the socket is protected (false: not an EventEmitter-like socket)
 */
export function protectSocketCloseListeners(socket) {
    if (!socket || typeof socket !== 'object') return false;
    if (isSocketProtected(socket)) return true;
    if (typeof socket.rawListeners !== 'function'
        || typeof socket.removeListener !== 'function'
        || typeof socket.removeAllListeners !== 'function') {
        return false;
    }

    // rawListeners: `once` listeners are recorded by their wrapper, which is what is attached
    const internal = new WeakSet(socket.rawListeners('close'));
    const original = socket.removeAllListeners;
    // Node sets socket.parser for server sockets and nulls it on upgrade / close
    const trackParser = socket.parser !== undefined && socket.parser !== null;

    Object.defineProperty(socket, STATE, { value: { internal }, configurable: true });
    Object.defineProperty(socket, 'removeAllListeners', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function removeAllListeners(type) {
            if (arguments.length === 0
                || type !== 'close'
                || this !== socket
                || (trackParser && (this.parser === undefined || this.parser === null))) {
                return Reflect.apply(original, this, arguments);
            }
            const listeners = this.rawListeners('close');
            for (let i = listeners.length - 1; i >= 0; i--) {
                if (!internal.has(listeners[i])) this.removeListener('close', listeners[i]);
            }
            return this;
        },
    });
    return true;
}

/**
 * Create the middleware (register it before every official router).
 * @returns {import('express').RequestHandler}
 */
export function createSocketCloseListenerGuard() {
    return function socketCloseListenerGuard(req, _res, next) {
        try {
            protectSocketCloseListeners(req.socket);
        } catch (error) {
            // Never block a request because of the patch; the socket just keeps the official behaviour
            console.error('[STC-MOD] Socket close-listener guard error:', /** @type {any} */ (error)?.message || error);
        }
        return next();
    };
}
