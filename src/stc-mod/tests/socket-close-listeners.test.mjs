/**
 * Tests: the official `req.socket.removeAllListeners('close')` no longer removes Node's own 'close'
 * listeners (middleware/socket-close-listeners.js), so closed connections are freed again, while the
 * official intent (drop the abort listeners of earlier requests on a keep-alive socket, abort the
 * upstream when the client disconnects) still holds.
 * Run: node src/stc-mod/tests/socket-close-listeners.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import fetch from 'node-fetch';
import { forwardFetchResponse } from '../../util.js';
import {
    createSocketCloseListenerGuard,
    isSocketProtected,
    protectSocketCloseListeners,
} from '../middleware/socket-close-listeners.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCKET_REMOVE_ALL = net.Socket.prototype.removeAllListeners;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// forwardFetchResponse logs every finished stream
const originalInfo = console.info;
console.info = (...args) => {
    if (args[0] === 'Streaming request finished') return;
    originalInfo(...args);
};

/** A socket as the first request finds it: Node's listeners only. */
function freshSocket() {
    const socket = new net.Socket();
    const calls = [];
    const socketOnClose = () => calls.push('socketOnClose');
    const onServerResponseClose = () => calls.push('onServerResponseClose');
    const internalOnce = () => calls.push('internalOnce');
    socket.on('close', socketOnClose);
    socket.once('close', internalOnce);
    socket.on('close', onServerResponseClose);
    return { socket, calls, socketOnClose, onServerResponseClose, internalOnce };
}

/** Plain listener functions (once wrappers resolved). */
const plain = (emitter, event = 'close') => emitter.listeners(event);

// --- Unit: EventEmitter / net.Socket level ---------------------------------------------------

test('removeAllListeners("close") keeps the listeners present when the socket was protected', () => {
    const { socket, calls, socketOnClose, onServerResponseClose, internalOnce } = freshSocket();
    const internalRaw = socket.rawListeners('close');
    assert.equal(protectSocketCloseListeners(socket), true);
    assert.equal(isSocketProtected(socket), true);

    const appAbort = () => calls.push('appAbort');
    const appOnce = () => calls.push('appOnce');
    socket.on('close', appAbort);
    socket.once('close', appOnce);
    socket.prependListener('close', appAbort);

    assert.equal(socket.removeAllListeners('close'), socket, 'chainable like the original');
    // Same functions (once wrapper included), same order
    assert.deepEqual(socket.rawListeners('close'), internalRaw);
    assert.deepEqual(plain(socket), [socketOnClose, internalOnce, onServerResponseClose]);

    socket.emit('close');
    socket.emit('close');
    assert.deepEqual(calls, ['socketOnClose', 'internalOnce', 'onServerResponseClose', 'socketOnClose', 'onServerResponseClose']);
    assert.deepEqual(plain(socket), [socketOnClose, onServerResponseClose], 'the once wrapper removed itself');
});

test('keep-alive: the next request removes the earlier abort listener; Node re-adding its listener is recognised', () => {
    const { socket, socketOnClose, onServerResponseClose, internalOnce } = freshSocket();
    const guard = createSocketCloseListenerGuard();
    const next = () => {};

    // Request 1: guard, then the official pattern
    guard({ socket }, {}, next);
    socket.removeAllListeners('close');
    const abort1 = () => {};
    socket.on('close', abort1);
    // Node detaches response 1 and assigns response 2 (same function), the once listener fired meanwhile
    socket.removeListener('close', onServerResponseClose);
    socket.removeListener('close', internalOnce);
    socket.on('close', onServerResponseClose);

    // Request 2 on the same socket
    guard({ socket }, {}, next);
    assert.deepEqual(plain(socket), [socketOnClose, abort1, onServerResponseClose]);
    socket.removeAllListeners('close');
    assert.deepEqual(plain(socket), [socketOnClose, onServerResponseClose], 'abort listener of request 1 removed');
    const abort2 = () => {};
    socket.on('close', abort2);

    // Request 3
    guard({ socket }, {}, next);
    socket.removeAllListeners('close');
    assert.deepEqual(plain(socket), [socketOnClose, onServerResponseClose]);
});

test('protecting is idempotent and never re-snapshots', () => {
    const { socket, socketOnClose, onServerResponseClose, internalOnce } = freshSocket();
    protectSocketCloseListeners(socket);
    const patched = socket.removeAllListeners;
    const app = () => {};
    socket.on('close', app);

    assert.equal(protectSocketCloseListeners(socket), true);
    assert.equal(socket.removeAllListeners, patched);
    socket.removeAllListeners('close');
    assert.deepEqual(plain(socket), [socketOnClose, internalOnce, onServerResponseClose]);
    assert.equal(Object.keys(socket).includes('removeAllListeners'), false, 'not enumerable');
});

test('other events, removeAllListeners() and other sockets behave as before', () => {
    const { socket } = freshSocket();
    socket.on('end', () => {});
    socket.on('timeout', () => {});
    protectSocketCloseListeners(socket);
    socket.on('end', () => {});

    socket.removeAllListeners('end');
    assert.equal(socket.listenerCount('end'), 0, 'other events: all removed');
    assert.equal(socket.listenerCount('close'), 3);
    socket.removeAllListeners();
    assert.equal(socket.listenerCount('close'), 0, 'no argument: everything removed');
    assert.equal(socket.listenerCount('timeout'), 0);

    const other = freshSocket().socket;
    other.removeAllListeners('close');
    assert.equal(other.listenerCount('close'), 0, 'unprotected socket: original behaviour');
    assert.equal(net.Socket.prototype.removeAllListeners, SOCKET_REMOVE_ALL, 'prototype untouched');
    assert.equal(other.removeAllListeners, SOCKET_REMOVE_ALL);
    // Calling the patched method on another object uses the original method
    const patched = socket.removeAllListeners;
    const third = freshSocket().socket;
    patched.call(third, 'close');
    assert.equal(third.listenerCount('close'), 0);
});

test('"removeListener" is emitted for the removed listeners only', () => {
    const { socket } = freshSocket();
    protectSocketCloseListeners(socket);
    const appA = function appA() {};
    const appB = function appB() {};
    socket.on('close', appA);
    socket.once('close', appB);
    const removed = [];
    socket.on('removeListener', (event, fn) => removed.push([event, fn.listener ?? fn]));
    socket.removeAllListeners('close');
    assert.deepEqual(removed, [['close', appB], ['close', appA]], 'last first, like the original');

    // Same events as the original method emits for these listeners
    const reference = new EventEmitter();
    reference.on('close', () => {});
    reference.on('close', appA);
    reference.once('close', appB);
    const expected = [];
    reference.on('removeListener', (event, fn) => expected.push([event, fn.listener ?? fn]));
    reference.removeAllListeners('close');
    assert.deepEqual(removed, expected.slice(0, 2));
});

test('sockets that left the HTTP parser (upgraded or closed) get the original behaviour', () => {
    const { socket } = freshSocket();
    socket.parser = {};
    protectSocketCloseListeners(socket);
    socket.on('close', () => {});
    socket.removeAllListeners('close');
    assert.equal(socket.listenerCount('close'), 3);

    socket.parser = null; // what Node does on upgrade / close
    socket.removeAllListeners('close');
    assert.equal(socket.listenerCount('close'), 0);
});

test('works on any EventEmitter; requests without a usable socket pass through', () => {
    const emitter = new EventEmitter();
    const internal = () => {};
    emitter.on('close', internal);
    assert.equal(protectSocketCloseListeners(emitter), true);
    emitter.on('close', () => {});
    emitter.removeAllListeners('close');
    assert.deepEqual(emitter.listeners('close'), [internal]);

    assert.equal(protectSocketCloseListeners(undefined), false);
    assert.equal(protectSocketCloseListeners(null), false);
    assert.equal(protectSocketCloseListeners({}), false);

    const guard = createSocketCloseListenerGuard();
    let nextCalls = 0;
    const next = () => nextCalls++;
    guard({}, {}, next);
    guard({ socket: null }, {}, next);
    guard({ socket: { on() {} } }, {}, next);
    // A socket that cannot be patched: logged, the request continues
    const frozen = Object.freeze(new EventEmitter());
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
        guard({ socket: frozen }, {}, next);
    } finally {
        console.error = originalError;
    }
    assert.equal(nextCalls, 4);
    assert.equal(logged.length, 1);
});

// --- Integration: real HTTP(S) server + Express ----------------------------------------------

/**
 * Express app with a route that uses the official pattern and records, per request, the socket's
 * 'close' listeners right after it.
 * @param {boolean} withGuard
 */
function recordingApp(withGuard) {
    const app = express();
    const seen = [];
    app.use(express.json());
    if (withGuard) app.use(createSocketCloseListenerGuard());
    app.post('/gen', (request, response) => {
        request.socket.removeAllListeners('close');
        const abort = function abortUpstream() {};
        request.socket.on('close', abort);
        seen.push({ socket: request.socket, abort, listeners: request.socket.rawListeners('close') });
        setTimeout(() => response.json({ ok: true }), Number(request.body?.delayMs) || 0);
    });
    return { app, seen };
}

/**
 * Listen on a random port; `nodeListeners` maps each socket to its 'close' listeners when its first
 * request arrived (before any application code: Node's own listeners).
 * @param {http.Server} server
 */
async function listen(server) {
    const nodeListeners = new Map();
    server.prependListener('request', (req) => {
        if (!nodeListeners.has(req.socket)) nodeListeners.set(req.socket, req.socket.rawListeners('close'));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {net.AddressInfo} */ (server.address());
    return { port, nodeListeners };
}

/**
 * Check each recorded request: all of Node's listeners are still attached, the only other one is
 * the abort listener of that request.
 */
function assertOnlyCurrentAbort(seen, nodeListeners) {
    for (const { socket, abort, listeners } of seen) {
        const internal = nodeListeners.get(socket);
        assert.ok(internal.length >= 2, 'Node attaches its own close listeners');
        for (const fn of internal) assert.ok(listeners.includes(fn), `Node listener ${fn.name} kept`);
        assert.deepEqual(listeners.filter((fn) => !internal.includes(fn)), [abort]);
    }
}

/** Send `count` POST /gen requests at once on one raw connection (HTTP pipelining). */
function pipelined(port, count, connect = net.connect, options = {}) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ delayMs: 30 });
        const one = `POST /gen HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`;
        const socket = connect({ port, host: '127.0.0.1', ...options });
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            text += chunk;
            if (text.split('HTTP/1.1 200').length - 1 === count && text.trimEnd().endsWith('}')) socket.end();
        });
        socket.on('close', () => resolve(text));
        socket.on('error', reject);
        socket.write(one.repeat(count));
    });
}

test('real server: keep-alive and pipelined requests keep Node\'s listeners and only the current abort listener', async () => {
    const { app, seen } = recordingApp(true);
    const server = http.createServer(app);
    const { port, nodeListeners } = await listen(server);
    try {
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        for (let i = 0; i < 4; i++) {
            const res = await fetch(`http://127.0.0.1:${port}/gen`, { method: 'post', agent, headers: { 'content-type': 'application/json' }, body: '{}' });
            assert.equal(res.status, 200);
            await res.text();
        }
        agent.destroy();
        assert.equal(new Set(seen.map((entry) => entry.socket)).size, 1, 'all requests on one keep-alive socket');

        await pipelined(port, 3);
        assert.equal(seen.length, 7);
        assert.equal(new Set(seen.slice(4).map((entry) => entry.socket)).size, 1);
        assertOnlyCurrentAbort(seen, nodeListeners);
    } finally {
        server.close();
        server.closeAllConnections();
    }
});

test('control: without the guard the official pattern removes Node\'s listeners', async () => {
    const { app, seen } = recordingApp(false);
    const server = http.createServer(app);
    const { port, nodeListeners } = await listen(server);
    try {
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        for (let i = 0; i < 2; i++) {
            const res = await fetch(`http://127.0.0.1:${port}/gen`, { method: 'post', agent, headers: { 'content-type': 'application/json' }, body: '{}' });
            await res.text();
        }
        agent.destroy();
        for (const { socket, abort, listeners } of seen) {
            assert.deepEqual(listeners, [abort]);
            assert.ok(nodeListeners.get(socket).length >= 2);
        }
    } finally {
        server.close();
        server.closeAllConnections();
    }
});

test('real HTTPS server: TLS and HTTP listeners are kept', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-socket-tls-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    if (made.status !== 0 || !fs.existsSync(certPath)) {
        t.skip('openssl not available');
        return;
    }
    const { app, seen } = recordingApp(true);
    const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
    const { port, nodeListeners } = await listen(server);
    try {
        const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
        for (let i = 0; i < 3; i++) {
            const res = await fetch(`https://127.0.0.1:${port}/gen`, { method: 'post', agent, headers: { 'content-type': 'application/json' }, body: '{}' });
            await res.text();
        }
        agent.destroy();
        assert.equal(new Set(seen.map((entry) => entry.socket)).size, 1);
        assert.ok(nodeListeners.get(seen[0].socket).length >= 4, 'TLS adds its own close listeners');
        assertOnlyCurrentAbort(seen, nodeListeners);
    } finally {
        server.close();
        server.closeAllConnections();
    }
});

/**
 * Mock upstream LLM: streams SSE chunks, `/slow` one every 20 ms (10 s in total), others at once.
 * `aborted` counts responses that were closed before they ended.
 */
async function mockUpstream() {
    const stats = { requests: 0, aborted: 0, abortedPaths: [] };
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            stats.requests++;
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.on('close', () => {
                if (!res.writableEnded) {
                    stats.aborted++;
                    stats.abortedPaths.push(req.url);
                }
            });
            const chunk = (i) => `data: {"choices":[{"delta":{"content":"token${i} "}}]}\n\n`;
            if (!req.url.endsWith('/slow')) {
                for (let i = 0; i < 20; i++) res.write(chunk(i));
                res.end('data: [DONE]\n\n');
                return;
            }
            let i = 0;
            const timer = setInterval(() => {
                res.write(chunk(i++));
                if (i === 500) {
                    clearInterval(timer);
                    res.end('data: [DONE]\n\n');
                }
            }, 20);
            res.on('close', () => clearInterval(timer));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {net.AddressInfo} */ (server.address());
    return { server, stats, url: `http://127.0.0.1:${port}` };
}

test('real server: a client disconnect still aborts the upstream request (keep-alive socket)', async () => {
    const upstream = await mockUpstream();
    const aborts = [];
    const app = express();
    app.use(express.json());
    app.use(createSocketCloseListenerGuard());
    app.post('/generate', async (request, response) => {
        const id = request.body.id;
        // Official pattern (chat-completions.js)
        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            controller.abort();
        });
        controller.signal.addEventListener('abort', () => aborts.push(id));
        try {
            const fetchResponse = await fetch(`${upstream.url}/${request.body.mode}`, { method: 'post', body: '{}', signal: controller.signal });
            return await forwardFetchResponse(fetchResponse, response);
        } catch {
            if (!response.headersSent) return response.status(500).end();
            return response.end();
        }
    });
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('request', (req) => sockets.add(req.socket));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {net.AddressInfo} */ (server.address());
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const post = (body) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/generate', method: 'POST', agent, headers: { 'content-type': 'application/json' } }, (res) => resolve({ req, res }));
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
    try {
        // Two complete generations on the socket
        for (const id of [1, 2]) {
            const { res } = await post({ id, mode: 'fast' });
            res.resume();
            await new Promise((resolve) => res.on('end', resolve));
        }
        // The third one is cancelled by the client after the first chunk
        const { req, res } = await post({ id: 3, mode: 'slow' });
        await new Promise((resolve) => res.once('data', resolve));
        req.on('error', () => {});
        res.on('error', () => {});
        req.destroy();

        const deadline = Date.now() + 3000;
        while (upstream.stats.aborted === 0 && Date.now() < deadline) await pause(20);
        assert.equal(sockets.size, 1, 'all three generations used one keep-alive socket');
        assert.equal(upstream.stats.requests, 3);
        assert.deepEqual(upstream.stats.abortedPaths, ['/slow'], 'the upstream saw the abort');
        assert.deepEqual(aborts, [3], 'only the current request was aborted (earlier abort listeners were removed)');
    } finally {
        agent.destroy();
        server.close();
        server.closeAllConnections();
        upstream.server.close();
        upstream.server.closeAllConnections();
    }
});

/**
 * Run the leak fixture in a child process with --expose-gc.
 * @param {'guard'|'official'} mode
 * @param {string} upstreamUrl
 * @param {number} requests
 */
function runLeakChild(mode, upstreamUrl, requests) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--expose-gc', path.join(__dirname, 'fixtures', 'socket-close-leak-server.mjs'), mode, upstreamUrl, String(requests)], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
            const line = stdout.trim().split('\n').reverse().find((text) => text.startsWith('{'));
            if (code !== 0 || !line) return reject(new Error(`leak child ${mode} exited ${code}: ${stderr.slice(-2000)}`));
            return resolve(JSON.parse(line));
        });
    });
}

test('real server: closed connections are freed after streamed generations (forced GC)', async () => {
    const upstream = await mockUpstream();
    const requests = 150;
    try {
        const url = `${upstream.url}/v1/chat/completions`;
        const official = await runLeakChild('official', url, requests);
        const guarded = await runLeakChild('guard', url, requests);
        console.log('[leak] official pattern without guard:', JSON.stringify(official));
        console.log('[leak] official pattern with guard:   ', JSON.stringify(guarded));

        // Without the guard every request stays in memory (proves the test sees the leak)
        assert.ok(official.retained >= requests * 0.9, `retained without guard: ${official.retained}`);
        const officialGrowth = official.heapGrowthMB + official.arrayBufferGrowthMB;
        assert.ok(officialGrowth > requests * 0.1, `growth without guard: ${officialGrowth} MB`);
        // With the guard (nearly) nothing is retained and memory stays flat
        assert.ok(guarded.retained <= requests * 0.05, `retained with guard: ${guarded.retained}`);
        const guardedGrowth = guarded.heapGrowthMB + guarded.arrayBufferGrowthMB;
        assert.ok(guardedGrowth < Math.max(2, officialGrowth / 10), `growth with guard: ${guardedGrowth} MB vs ${officialGrowth} MB`);
    } finally {
        upstream.server.close();
        upstream.server.closeAllConnections();
    }
});
