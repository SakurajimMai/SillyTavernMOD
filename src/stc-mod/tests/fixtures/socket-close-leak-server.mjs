/**
 * Child process of socket-close-listeners.test.mjs (needs --expose-gc).
 * Runs an Express server with a streamed generation endpoint that uses the official pattern
 * (`removeAllListeners('close')` + abort listener, node-fetch upstream, the official
 * forwardFetchResponse), sends generations to it, each on its own connection that is closed
 * afterwards, forces GC and prints one JSON line with the retained request count and memory growth.
 * Usage: node --expose-gc socket-close-leak-server.mjs <guard|official> <upstreamUrl> <requests>
 */
/* global gc, WeakRef */
import http from 'node:http';
import express from 'express';
import fetch from 'node-fetch';
import { forwardFetchResponse } from '../../../util.js';
import { createSocketCloseListenerGuard } from '../../middleware/socket-close-listeners.js';

const [mode, upstreamUrl, countArg] = process.argv.slice(2);
const REQUESTS = Number(countArg) || 150;
const WARMUP = 20;
const CONCURRENCY = 5;
const MB = 1024 * 1024;

if (typeof gc !== 'function') throw new Error('run with --expose-gc');
if (mode !== 'guard' && mode !== 'official') throw new Error('mode must be guard or official');

// ~120 KB prompt like a long chat (every generation request carries the whole prompt)
const body = JSON.stringify({
    stream: true,
    messages: Array.from({ length: 170 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${'x'.repeat(700)} ${i}` })),
});

/** WeakRefs to the server-side request objects of the measured phase. */
const tracked = [];
let tracking = false;

const app = express();
app.use(express.json({ limit: '50mb' }));
if (mode === 'guard') app.use(createSocketCloseListenerGuard());
app.post('/generate', async (request, response) => {
    if (tracking) tracked.push(new WeakRef(request));
    // Same as the official generation handlers (e.g. chat-completions.js)
    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });
    try {
        const fetchResponse = await fetch(upstreamUrl, {
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: request.body.messages, stream: true }),
            signal: controller.signal,
        });
        return await forwardFetchResponse(fetchResponse, response);
    } catch {
        if (!response.headersSent) return response.status(500).send({ error: true });
        return response.end();
    }
});

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

/** One generation on its own connection (closed by the server after the response). */
function generate() {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/generate',
            method: 'POST',
            agent: false,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' },
        }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * Run `count` generations with a few in parallel.
 * @param {number} count
 */
async function run(count) {
    let started = 0;
    const statuses = [];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (started < count) {
            started++;
            statuses.push(await generate());
        }
    }));
    if (statuses.some((status) => status !== 200)) throw new Error(`unexpected status ${statuses.find((s) => s !== 200)}`);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Full GC (WeakRefs are only cleared between jobs), then memory in MB. */
async function collect() {
    await pause(300);
    for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        gc();
    }
    const memory = process.memoryUsage();
    return { heapUsed: memory.heapUsed / MB, arrayBuffers: memory.arrayBuffers / MB };
}

await run(WARMUP);
const before = await collect();
tracking = true;
await run(REQUESTS);
tracking = false;
const after = await collect();
const retained = tracked.filter((ref) => ref.deref() !== undefined).length;

console.log(JSON.stringify({
    mode,
    requests: REQUESTS,
    tracked: tracked.length,
    retained,
    heapGrowthMB: +(after.heapUsed - before.heapUsed).toFixed(2),
    arrayBufferGrowthMB: +(after.arrayBuffers - before.arrayBuffers).toFixed(2),
}));
server.close();
server.closeAllConnections();
process.exit(0);
