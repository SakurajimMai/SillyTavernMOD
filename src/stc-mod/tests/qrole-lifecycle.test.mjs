/**
 * STC-MOD - QRole membership lifecycle tests (pure logic, no server, no network).
 * Run: node src/stc-mod/tests/qrole-lifecycle.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    DAY_MS,
    DEFAULT_RENEW_URL,
    LAPSE_RECHECK_PAUSE_MS,
    buildMembershipSnapshot,
    checkCleanupStillDue,
    computeCleanupAt,
    computeRefreshTokenExpiry,
    decideQroleSession,
    evaluateQroleSession,
    getCleanupEligibility,
    getQroleAccountState,
    hasStoredRefreshToken,
    isLapseRecentlyConfirmed,
    isRefreshTokenFeatureOn,
    planVerificationOutcome,
    resolveQroleLifecycleConfig,
    stateToReason,
} from '../services/qrole-lifecycle.js';
import { decryptToken, encryptToken, loadOrCreateKeyFile, parseKeyFile } from '../services/qrole-token-crypto.js';
import { buildQroleTokenRequest, classifyRefreshFailure, refreshQroleIdentity } from '../services/oauth-client.js';
import { sanitizeMeta } from '../user-metadata.js';

const HOUR_MS = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const CFG = Object.freeze({ requireMembership: true, allowedTiers: ['vip', 'svip'], reverifyHours: 24 });

/**
 * Metadata of a QRole account with a valid VIP snapshot checked `checkedAgoMs` ago.
 * @param {object} [overrides]
 * @returns {object}
 */
function memberMeta(overrides = {}) {
    return {
        oauthProvider: 'qrole',
        oauthUserId: 'u-1',
        qroleTier: 'vip',
        qroleMembershipExpiresAt: NOW + 10 * DAY_MS,
        qroleCheckedAt: NOW - HOUR_MS,
        qroleRefreshToken: 'v1.x.y.z',
        qroleRefreshTokenExpiresAt: NOW + 20 * DAY_MS,
        lastLoginAt: NOW - 5 * DAY_MS,
        lastActiveAt: NOW - 2 * DAY_MS,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Token envelope
// ---------------------------------------------------------------------------

test('token envelope: round trip, random IV, versioned format', () => {
    const key = crypto.randomBytes(32);
    const a = encryptToken('refresh-token-123', 'alice', key);
    const b = encryptToken('refresh-token-123', 'alice', key);
    assert.match(a, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.notEqual(a, b, 'a random IV makes every envelope different');
    assert.equal(decryptToken(a, 'alice', key), 'refresh-token-123');
    assert.equal(decryptToken(b, 'alice', key), 'refresh-token-123');
});

test('token envelope: tampering, wrong AAD, wrong key and garbage fail closed', () => {
    const key = crypto.randomBytes(32);
    const envelope = encryptToken('secret-refresh-token', 'alice', key);
    const [version, iv, tag, ciphertext] = envelope.split('.');
    const flip = (text) => {
        const buf = Buffer.from(text, 'base64url');
        buf[0] ^= 0x01;
        return buf.toString('base64url');
    };

    assert.equal(decryptToken([version, iv, tag, flip(ciphertext)].join('.'), 'alice', key), null, 'ciphertext tamper');
    assert.equal(decryptToken([version, iv, flip(tag), ciphertext].join('.'), 'alice', key), null, 'tag tamper');
    assert.equal(decryptToken([version, flip(iv), tag, ciphertext].join('.'), 'alice', key), null, 'iv tamper');
    assert.equal(decryptToken(['v2', iv, tag, ciphertext].join('.'), 'alice', key), null, 'unknown version');
    assert.equal(decryptToken(envelope, 'bob', key), null, 'wrong AAD (other account)');
    assert.equal(decryptToken(envelope, 'alice', crypto.randomBytes(32)), null, 'wrong key');
    assert.equal(decryptToken('garbage', 'alice', key), null);
    assert.equal(decryptToken(null, 'alice', key), null);
    assert.equal(decryptToken(envelope, 'alice', Buffer.alloc(8)), null, 'invalid key length');
    assert.throws(() => encryptToken('x', 'alice', Buffer.alloc(8)));
});

test('key file: created once with mode 0600, reused, invalid content rejected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-token-key-'));
    try {
        const file = path.join(dir, 'stc-mod-token.key');
        const first = loadOrCreateKeyFile(file);
        assert.equal(first.length, 32);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        }
        const second = loadOrCreateKeyFile(file);
        assert.ok(first.equals(second), 'existing key is reused');
        assert.deepEqual(fs.readdirSync(dir), ['stc-mod-token.key'], 'no temp files left behind');

        assert.equal(parseKeyFile('not a key'), null);
        assert.ok(parseKeyFile(`  ${first.toString('base64')}\n`)?.equals(first));

        const broken = path.join(dir, 'broken.key');
        fs.writeFileSync(broken, 'oops');
        assert.throws(() => loadOrCreateKeyFile(broken), /valid key/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('lifecycle config: defaults, clamping and validation', () => {
    const defaults = resolveQroleLifecycleConfig(undefined);
    assert.deepEqual(defaults, {
        requireMembership: true,
        backgroundReverify: true,
        renewUrl: DEFAULT_RENEW_URL,
        expiryReminderDays: 7,
        expiredDataExport: true,
        expiredCleanup: { enabled: false, afterDays: 90 },
        reverifyHours: 24,
    });

    const custom = resolveQroleLifecycleConfig({
        backgroundReverify: false,
        renewUrl: 'javascript:alert(1)',
        expiryReminderDays: 100,
        expiredDataExport: false,
        expiredCleanup: { enabled: true, afterDays: 5 },
    });
    assert.equal(custom.backgroundReverify, false);
    assert.equal(custom.renewUrl, DEFAULT_RENEW_URL, 'non-http(s) renew URL falls back to the default');
    assert.equal(custom.expiryReminderDays, 60);
    assert.equal(custom.expiredDataExport, false);
    assert.deepEqual(custom.expiredCleanup, { enabled: true, afterDays: 30 });

    assert.equal(resolveQroleLifecycleConfig({ expiryReminderDays: -3 }).expiryReminderDays, 0);
    assert.equal(resolveQroleLifecycleConfig({ expiryReminderDays: '14' }).expiryReminderDays, 14);
    assert.equal(resolveQroleLifecycleConfig({ expiryReminderDays: 'abc' }).expiryReminderDays, 7);
    assert.equal(resolveQroleLifecycleConfig({ expiredCleanup: { afterDays: 99999 } }).expiredCleanup.afterDays, 3650);
    assert.equal(resolveQroleLifecycleConfig({ expiredCleanup: { enabled: 'yes' } }).expiredCleanup.enabled, false, 'only true enables cleanup');
    assert.equal(resolveQroleLifecycleConfig({ renewUrl: ' https://example.com/renew ' }).renewUrl, 'https://example.com/renew');

    assert.equal(isRefreshTokenFeatureOn(resolveQroleLifecycleConfig({})), true);
    assert.equal(isRefreshTokenFeatureOn(resolveQroleLifecycleConfig({ requireMembership: false })), false);
    assert.equal(isRefreshTokenFeatureOn(resolveQroleLifecycleConfig({ backgroundReverify: false })), false);
});

test('refresh token expiry: reported lifetime, 30-day default, 90-day cap', () => {
    assert.equal(computeRefreshTokenExpiry(3600, NOW), NOW + HOUR_MS);
    assert.equal(computeRefreshTokenExpiry('7200', NOW), NOW + 2 * HOUR_MS);
    assert.equal(computeRefreshTokenExpiry(undefined, NOW), NOW + 30 * DAY_MS);
    assert.equal(computeRefreshTokenExpiry(-5, NOW), NOW + 30 * DAY_MS);
    assert.equal(computeRefreshTokenExpiry(365 * 24 * 3600, NOW), NOW + 90 * DAY_MS);

    assert.equal(hasStoredRefreshToken(memberMeta(), NOW), true);
    assert.equal(hasStoredRefreshToken(memberMeta({ qroleRefreshTokenExpiresAt: NOW }), NOW), false, 'expired token');
    assert.equal(hasStoredRefreshToken(memberMeta({ qroleRefreshTokenExpiresAt: undefined }), NOW), false, 'no expiry recorded');
    assert.equal(hasStoredRefreshToken(memberMeta({ qroleRefreshToken: '' }), NOW), false);
});

// ---------------------------------------------------------------------------
// Session evaluation, account state, cleanup date, snapshots
// ---------------------------------------------------------------------------

test('evaluateQroleSession: expiry, tier, re-verification window (API doubled)', () => {
    assert.deepEqual(evaluateQroleSession(memberMeta(), CFG, NOW), { valid: true, reason: null });
    assert.equal(evaluateQroleSession(memberMeta({ qroleMembershipExpiresAt: NOW - 1 }), CFG, NOW).reason, 'membership_expired');
    assert.equal(evaluateQroleSession(memberMeta({ qroleTier: 'free' }), CFG, NOW).reason, 'not_member');
    const due = memberMeta({ qroleCheckedAt: NOW - 30 * HOUR_MS });
    assert.equal(evaluateQroleSession(due, CFG, NOW).reason, 'membership_reverify');
    assert.equal(evaluateQroleSession(due, CFG, NOW, { isApi: true }).valid, true);
    assert.equal(evaluateQroleSession(memberMeta({ qroleTier: 'free' }), { ...CFG, requireMembership: false }, NOW).valid, true);
});

test('account state and cleanup date', () => {
    const cleanup = { enabled: true, afterDays: 90 };

    const active = getQroleAccountState(memberMeta(), CFG, NOW);
    assert.deepEqual(active, { state: 'active', expiredSince: null });
    assert.equal(computeCleanupAt(memberMeta(), active, cleanup), null, 'active accounts are never cleaned');

    const expiredMeta = memberMeta({ qroleMembershipExpiresAt: NOW - 100 * DAY_MS, lastLoginAt: NOW - 120 * DAY_MS, lastActiveAt: NOW - 110 * DAY_MS });
    const expired = getQroleAccountState(expiredMeta, CFG, NOW);
    assert.deepEqual(expired, { state: 'expired', expiredSince: NOW - 100 * DAY_MS });
    assert.equal(stateToReason(expired.state), 'membership_expired');
    assert.equal(computeCleanupAt(expiredMeta, expired, cleanup), NOW - 10 * DAY_MS, 'latest reference (expiry) + 90 days');
    assert.equal(computeCleanupAt(expiredMeta, expired, { enabled: false, afterDays: 90 }), null, 'disabled');

    // Activity after the expiry postpones the cleanup
    const activeAfter = { ...expiredMeta, lastActiveAt: NOW - 5 * DAY_MS };
    assert.equal(computeCleanupAt(activeAfter, getQroleAccountState(activeAfter, CFG, NOW), cleanup), NOW + 85 * DAY_MS);

    const freeMeta = memberMeta({ qroleTier: 'free', qroleMembershipExpiresAt: null, qroleDeniedAt: NOW - 40 * DAY_MS, qroleCheckedAt: NOW - DAY_MS, lastLoginAt: undefined, lastActiveAt: undefined });
    const notMember = getQroleAccountState(freeMeta, CFG, NOW);
    assert.deepEqual(notMember, { state: 'not_member', expiredSince: NOW - 40 * DAY_MS });
    assert.equal(stateToReason(notMember.state), 'not_member');
    assert.equal(computeCleanupAt(freeMeta, notMember, { enabled: true, afterDays: 30 }), NOW - 10 * DAY_MS);

    const checkedOnly = { ...freeMeta, qroleDeniedAt: undefined };
    assert.equal(getQroleAccountState(checkedOnly, CFG, NOW).expiredSince, NOW - DAY_MS, 'falls back to qroleCheckedAt');

    const noDates = { oauthProvider: 'qrole', qroleTier: null };
    assert.equal(computeCleanupAt(noDates, getQroleAccountState(noDates, CFG, NOW), cleanup), null, 'no reference date → never cleaned automatically');
});

test('membership snapshot: renewals clear the denial, lapses keep the last known expiry', () => {
    const lapsed = memberMeta({ qroleMembershipExpiresAt: NOW - 3 * DAY_MS });

    // QRole reports a lapsed membership as free without expiry
    const free = { allowed: false, code: 'not_member', tier: 'free', expiresAt: null, tierName: '免费' };
    const patch = buildMembershipSnapshot(lapsed, free, NOW);
    assert.equal(patch.qroleTier, 'free');
    assert.equal(patch.qroleMembershipExpiresAt, NOW - 3 * DAY_MS, 'last known expiry kept');
    assert.equal(patch.qroleCheckedAt, NOW);
    assert.equal(patch.qroleDeniedAt, NOW, 'first time seen lapsed');
    assert.equal(patch.qroleTierName, '免费');
    assert.equal(getQroleAccountState({ ...lapsed, ...patch }, CFG, NOW).state, 'expired');

    const later = buildMembershipSnapshot({ ...lapsed, ...patch }, free, NOW + DAY_MS);
    assert.equal(later.qroleDeniedAt, NOW, 'background checks keep the first denial date');
    const deniedLogin = buildMembershipSnapshot({ ...lapsed, ...patch }, free, NOW + DAY_MS, { denied: true });
    assert.equal(deniedLogin.qroleDeniedAt, NOW + DAY_MS, 'every denied login records the attempt (latest one counts)');
    const notMemberAgain = { oauthProvider: 'qrole', qroleTier: 'free', qroleDeniedAt: NOW - 80 * DAY_MS, qroleCheckedAt: NOW - 80 * DAY_MS };
    const retry = { ...notMemberAgain, ...buildMembershipSnapshot(notMemberAgain, { allowed: false, code: 'not_member', tier: 'free', expiresAt: null }, NOW, { denied: true }) };
    assert.equal(getQroleAccountState(retry, CFG, NOW).expiredSince, NOW, 'non-member cleanup date counts from the most recent denied login');

    const renewed = buildMembershipSnapshot({ ...lapsed, ...patch }, { allowed: true, code: null, tier: 'VIP', expiresAt: NOW + 30 * DAY_MS }, NOW);
    assert.deepEqual(renewed, { qroleTier: 'vip', qroleMembershipExpiresAt: NOW + 30 * DAY_MS, qroleCheckedAt: NOW, qroleDeniedAt: null });
});

// ---------------------------------------------------------------------------
// Refresh outcome classification and the verification plan
// ---------------------------------------------------------------------------

/**
 * fetch stub answering the token and userinfo requests in order.
 * @param {Array<Response|Error>} responses
 * @returns {{fetchImpl: typeof fetch, calls: {url: string, init: RequestInit}[]}}
 */
function stubFetch(responses) {
    const calls = [];
    const queue = [...responses];
    return {
        calls,
        fetchImpl: async (url, init) => {
            calls.push({ url: String(url), init });
            const next = queue.shift();
            if (next instanceof Error) throw next;
            return next;
        },
    };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const QROLE_CFG = { ...CFG, clientId: 'client-1', clientSecret: 'secret-1', tokenUrl: 'https://idp.example/token', userInfoUrl: 'https://idp.example/userinfo' };

test('refresh classification: definitive vs transient', async () => {
    const refresh = async (...responses) => refreshQroleIdentity(QROLE_CFG, 'rt', { fetchImpl: stubFetch(responses).fetchImpl });
    const run = async (...responses) => (await refresh(...responses)).kind;

    assert.equal(await run(json({ error: 'invalid_grant' }, 400)), 'definitive');
    assert.equal(await run(json({ token_type: 'Bearer' })), 'definitive', 'malformed token response');
    // A rejected client (rotated secret, disabled client) is not evidence against the account
    assert.deepEqual(await refresh(json({ error: 'invalid_client' }, 401)), { kind: 'transient', reason: 'invalid_client' });
    assert.deepEqual(await refresh(json({ error: 'invalid_client' }, 400)), { kind: 'transient', reason: 'invalid_client' });
    assert.deepEqual(await refresh(new Response('Unauthorized', { status: 401 })), { kind: 'transient', reason: 'invalid_client' }, 'bare 401');
    assert.equal(await run(json({ error: 'server_error' }, 500)), 'transient');
    assert.equal(await run(json({ error: 'slow_down' }, 429)), 'transient');
    assert.equal(await run(new Response('<html>bad gateway</html>', { status: 200 })), 'transient', 'unparsable');
    assert.equal(await run(Object.assign(new Error('fetch failed'), { name: 'TypeError' })), 'transient', 'network error');
    assert.equal(await run(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 'transient', 'timeout');
    assert.equal(await run(json({ access_token: 'at' }), json({}, 503)), 'transient', 'userinfo 5xx');

    assert.deepEqual(classifyRefreshFailure({ ok: false, failure: 'http', status: 403, data: null, detail: '' }), { kind: 'transient', reason: 'http_403' });
});

test('refresh round trip: client auth and identity extraction', async () => {
    const { fetchImpl, calls } = stubFetch([
        json({ access_token: 'new-access' }),
        json({ sub: 'u-1', membership_tier: 'vip', membership_tier_name: 'VIP 会员', membership_expires_at: new Date(NOW + 30 * DAY_MS).toISOString() }),
    ]);
    const refreshed = await refreshQroleIdentity(QROLE_CFG, 'the-refresh-token', { fetchImpl });
    assert.equal(refreshed.kind, 'ok');
    assert.equal(refreshed.identityId, 'u-1');
    assert.equal(calls.length, 2);
    const body = new URLSearchParams(String(calls[0].init.body));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'the-refresh-token');
    assert.equal(body.get('client_id'), 'client-1', 'client_secret_post puts the credentials in the body');
    assert.equal(body.get('client_secret'), 'secret-1');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer new-access');

    const basic = buildQroleTokenRequest({ ...QROLE_CFG, tokenAuthMethod: 'client_secret_basic' }, { grant_type: 'refresh_token', refresh_token: 'rt' });
    assert.equal(basic.headers.Authorization, `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`);
    assert.equal(new URLSearchParams(basic.body).get('client_secret'), null);
});

test('verification plan: definitive removes the token, transient keeps it, ok updates the snapshot', () => {
    const meta = memberMeta({ qroleMembershipExpiresAt: NOW - DAY_MS });

    const definitive = planVerificationOutcome({ kind: 'definitive', reason: 'invalid_grant' }, meta, CFG, NOW);
    assert.equal(definitive.result, 'definitive');
    assert.equal(definitive.clearToken, true);

    const transient = planVerificationOutcome({ kind: 'transient', reason: 'timeout' }, meta, CFG, NOW);
    assert.deepEqual([transient.result, transient.clearToken, transient.cooldown], ['transient', false, true]);

    const clientRejected = planVerificationOutcome({ kind: 'transient', reason: 'invalid_client' }, meta, CFG, NOW);
    assert.deepEqual([clientRejected.result, clientRejected.reason, clientRejected.clearToken, clientRejected.cooldown], ['transient', 'invalid_client', false, true], 'invalid_client keeps the token');

    const mismatch = planVerificationOutcome({ kind: 'ok', reason: null, identityId: 'someone-else', claims: { sub: 'someone-else', membership_tier: 'vip' } }, meta, CFG, NOW);
    assert.deepEqual([mismatch.result, mismatch.reason, mismatch.clearToken], ['definitive', 'identity_mismatch', true]);

    const unknown = planVerificationOutcome({ kind: 'ok', reason: null, identityId: 'u-1', claims: { sub: 'u-1' } }, meta, CFG, NOW);
    assert.deepEqual([unknown.result, unknown.reason, unknown.clearToken, unknown.cooldown], ['transient', 'membership_unknown', false, true]);

    const suspended = planVerificationOutcome({ kind: 'ok', reason: null, identityId: 'u-1', claims: { sub: 'u-1', status: 'banned', membership_tier: 'vip' } }, meta, CFG, NOW);
    assert.deepEqual([suspended.result, suspended.clearToken], ['definitive', true]);

    const renewedExpiry = NOW + 30 * DAY_MS;
    const renewed = planVerificationOutcome({ kind: 'ok', reason: null, identityId: 'u-1', claims: { sub: 'u-1', membership_tier: 'svip', membership_tier_name: 'SVIP', membership_expires_at: renewedExpiry } }, meta, CFG, NOW);
    assert.equal(renewed.result, 'ok');
    assert.equal(renewed.reason, null);
    assert.equal(renewed.clearToken, false);
    assert.deepEqual(renewed.patch, { qroleTier: 'svip', qroleMembershipExpiresAt: renewedExpiry, qroleCheckedAt: NOW, qroleTierName: 'SVIP', qroleDeniedAt: null, qroleVerifiedVia: 'refresh' });

    const stillFree = planVerificationOutcome({ kind: 'ok', reason: null, identityId: 'u-1', claims: { sub: 'u-1', membership_tier: 'free', membership_expires_at: null } }, meta, CFG, NOW);
    assert.equal(stillFree.result, 'ok');
    assert.equal(stillFree.reason, 'not_member');
    assert.equal(stillFree.patch.qroleMembershipExpiresAt, NOW - DAY_MS, 'lapsed expiry kept');
});

// ---------------------------------------------------------------------------
// Guard decision table (stubbed verifier)
// ---------------------------------------------------------------------------

/**
 * Run the guard decision with a stubbed verifier that behaves like the real service
 * (ok → snapshot patched, definitive → token removed).
 * @param {object} meta
 * @param {{result: string, patch?: object}|null} verifierOutcome null = verifier must not be called
 * @param {object} [opts]
 * @returns {Promise<{decision: object, calls: number, store: {meta: object}}>}
 */
async function decide(meta, verifierOutcome, opts = {}) {
    const store = { meta: { ...meta } };
    let calls = 0;
    const decision = await decideQroleSession({
        meta: store.meta,
        cfg: opts.cfg || CFG,
        now: NOW,
        isApi: !!opts.isApi,
        verifyAvailable: opts.verifyAvailable ?? hasStoredRefreshToken(store.meta, NOW),
        inCooldown: !!opts.inCooldown,
        verify: async () => {
            calls++;
            assert.ok(verifierOutcome, 'verifier must not be called');
            if (verifierOutcome.result === 'ok') store.meta = { ...store.meta, ...verifierOutcome.patch };
            if (verifierOutcome.result === 'definitive') {
                store.meta = { ...store.meta };
                delete store.meta.qroleRefreshToken;
                delete store.meta.qroleRefreshTokenExpiresAt;
            }
            return { result: verifierOutcome.result, reason: null };
        },
        reloadMeta: () => store.meta,
        clock: () => NOW,
    });
    return { decision, calls, store };
}

test('guard: valid snapshot never calls QRole', async () => {
    const { decision, calls } = await decide(memberMeta(), null);
    assert.deepEqual(decision, { valid: true, reason: null, verification: null });
    assert.equal(calls, 0);
});

test('guard: renewed membership continues seamlessly', async () => {
    const expired = memberMeta({ qroleMembershipExpiresAt: NOW - DAY_MS, qroleCheckedAt: NOW - 3 * DAY_MS });
    const { decision, calls } = await decide(expired, { result: 'ok', patch: { qroleTier: 'vip', qroleMembershipExpiresAt: NOW + 30 * DAY_MS, qroleCheckedAt: NOW } });
    assert.equal(calls, 1);
    assert.deepEqual(decision, { valid: true, reason: null, verification: 'ok' });

    const due = memberMeta({ qroleCheckedAt: NOW - 30 * HOUR_MS });
    const refreshed = await decide(due, { result: 'ok', patch: { qroleCheckedAt: NOW } });
    assert.equal(refreshed.decision.valid, true);
});

test('guard: QRole confirms the lapse → session ends', async () => {
    const expired = memberMeta({ qroleMembershipExpiresAt: NOW - DAY_MS });
    const { decision } = await decide(expired, { result: 'ok', patch: { qroleTier: 'free', qroleCheckedAt: NOW } });
    assert.deepEqual(decision, { valid: false, reason: 'membership_expired', verification: 'ok' });
});

test('guard: definitive failure denies and the token is gone', async () => {
    const due = memberMeta({ qroleCheckedAt: NOW - 30 * HOUR_MS });
    const { decision, store } = await decide(due, { result: 'definitive' });
    assert.deepEqual(decision, { valid: false, reason: 'membership_reverify', verification: 'definitive' });
    assert.equal(store.meta.qroleRefreshToken, undefined);
    assert.equal(hasStoredRefreshToken(store.meta, NOW), false);

    const noToken = await decide(due, { result: 'no_token' });
    assert.equal(noToken.decision.valid, false);
});

test('guard: transient grace only for membership_reverify, within 2x the window', async () => {
    const due = memberMeta({ qroleCheckedAt: NOW - 30 * HOUR_MS });
    assert.deepEqual((await decide(due, { result: 'transient' })).decision, { valid: true, reason: null, verification: 'transient' });

    const tooOld = memberMeta({ qroleCheckedAt: NOW - 49 * HOUR_MS });
    assert.deepEqual((await decide(tooOld, { result: 'transient' })).decision, { valid: false, reason: 'membership_reverify', verification: 'transient' });
    assert.equal((await decide(tooOld, { result: 'transient' }, { isApi: true })).decision.valid, false, 'API beyond 2x as well');

    const expired = memberMeta({ qroleMembershipExpiresAt: NOW - DAY_MS });
    assert.deepEqual((await decide(expired, { result: 'transient' })).decision, { valid: false, reason: 'membership_expired', verification: 'transient' });

    const free = memberMeta({ qroleTier: 'free' });
    assert.deepEqual((await decide(free, { result: 'transient' })).decision, { valid: false, reason: 'not_member', verification: 'transient' });
});

test('guard: cooldown skips QRole and applies the same grace rule', async () => {
    const due = memberMeta({ qroleCheckedAt: NOW - 30 * HOUR_MS });
    const graced = await decide(due, null, { inCooldown: true });
    assert.equal(graced.calls, 0);
    assert.deepEqual(graced.decision, { valid: true, reason: null, verification: 'cooldown' });

    const expired = memberMeta({ qroleMembershipExpiresAt: NOW - DAY_MS });
    const denied = await decide(expired, null, { inCooldown: true });
    assert.equal(denied.calls, 0);
    assert.deepEqual(denied.decision, { valid: false, reason: 'membership_expired', verification: 'cooldown' });
});

test('guard: QRole reported the lapse moments ago → old cookies are refused without another round trip', async () => {
    // Background check at NOW - 1 min: QRole said free (snapshot keeps the past expiry, denial recorded)
    const lapsed = memberMeta({ qroleMembershipExpiresAt: NOW - DAY_MS, qroleTier: 'free', qroleCheckedAt: NOW - 60 * 1000, qroleDeniedAt: NOW - 60 * 1000 });
    assert.equal(isLapseRecentlyConfirmed(lapsed, NOW), true);
    for (let i = 0; i < 5; i++) {
        const replay = await decide(lapsed, null);
        assert.equal(replay.calls, 0, 'verifier must not be called for a replay');
        assert.deepEqual(replay.decision, { valid: false, reason: 'membership_expired', verification: 'recent' });
    }

    // After the pause, QRole is asked again (e.g. the member renewed meanwhile)
    const later = memberMeta({ ...lapsed, qroleCheckedAt: NOW - LAPSE_RECHECK_PAUSE_MS - 1 });
    assert.equal(isLapseRecentlyConfirmed(later, NOW), false);
    const renewed = await decide(later, { result: 'ok', patch: { qroleTier: 'vip', qroleMembershipExpiresAt: NOW + 30 * DAY_MS, qroleCheckedAt: NOW, qroleDeniedAt: null } });
    assert.equal(renewed.calls, 1);
    assert.deepEqual(renewed.decision, { valid: true, reason: null, verification: 'ok' });

    // A snapshot that was VALID when checked a moment ago and has just run out is re-verified
    // (renewals right before the expiry must continue seamlessly)
    const justExpired = memberMeta({ qroleMembershipExpiresAt: NOW - 1000, qroleCheckedAt: NOW - 60 * 1000, qroleDeniedAt: null });
    assert.equal(isLapseRecentlyConfirmed(justExpired, NOW), false);
    const continued = await decide(justExpired, { result: 'ok', patch: { qroleMembershipExpiresAt: NOW + 30 * DAY_MS, qroleCheckedAt: NOW } });
    assert.equal(continued.calls, 1);
    assert.equal(continued.decision.valid, true);

    // allowedTiers changed after a successful login: re-verified (QRole may report a higher tier now)
    const tierRemoved = await decide(memberMeta({ qroleCheckedAt: NOW - 60 * 1000, qroleDeniedAt: null }), { result: 'ok', patch: { qroleTier: 'vip', qroleCheckedAt: NOW, qroleDeniedAt: NOW } }, { cfg: { ...CFG, allowedTiers: ['svip'] } });
    assert.equal(tierRemoved.calls, 1);
    assert.deepEqual(tierRemoved.decision, { valid: false, reason: 'not_member', verification: 'ok' });

    // Clock skew: a check "in the future" does not pause anything
    assert.equal(isLapseRecentlyConfirmed({ ...lapsed, qroleCheckedAt: NOW + 60 * 1000 }, NOW), false);
});

test('guard: without a usable token (or feature off) today\'s rules apply', async () => {
    const due = memberMeta({ qroleCheckedAt: NOW - 30 * HOUR_MS, qroleRefreshToken: undefined });
    const page = await decide(due, null);
    assert.deepEqual(page.decision, { valid: false, reason: 'membership_reverify', verification: null });
    const api = await decide(due, null, { isApi: true });
    assert.deepEqual(api.decision, { valid: true, reason: null, verification: null }, 'API keeps the doubled window');

    const off = await decide(memberMeta({ qroleMembershipExpiresAt: NOW - DAY_MS }), null, { verifyAvailable: false });
    assert.deepEqual(off.decision, { valid: false, reason: 'membership_expired', verification: null });
});

// ---------------------------------------------------------------------------
// Cleanup: final check right before a deletion
// ---------------------------------------------------------------------------

test('cleanup final check: vetoes renewed, re-linked, gone and switched-off cases', () => {
    const lifecycle = resolveQroleLifecycleConfig({ ...CFG, expiredCleanup: { enabled: true, afterDays: 90 } });
    const lapsedMeta = memberMeta({ qroleMembershipExpiresAt: NOW - 100 * DAY_MS, lastLoginAt: NOW - 120 * DAY_MS, lastActiveAt: NOW - 110 * DAY_MS });
    const base = { cfg: CFG, lifecycle, meta: lapsedMeta, oauthUserId: 'u-1', now: NOW };

    const due = checkCleanupStillDue(base);
    assert.equal(due.veto, null);
    assert.equal(due.eligibility?.eligible, true);
    assert.deepEqual(getCleanupEligibility(lapsedMeta, CFG, lifecycle, NOW), due.eligibility);

    // Renewed (e.g. QRole login while the job was measuring storage)
    const renewedMeta = { ...lapsedMeta, qroleMembershipExpiresAt: NOW + 30 * DAY_MS, qroleCheckedAt: NOW, qroleDeniedAt: null };
    assert.equal(checkCleanupStillDue({ ...base, meta: renewedMeta }).veto, 'renewed');
    // Activity since the job's first check moves the cleanup date
    assert.equal(checkCleanupStillDue({ ...base, meta: { ...lapsedMeta, lastActiveAt: NOW - DAY_MS } }).veto, 'not_due');
    // Deleted / made admin / unlinked (no live QRole account) or re-linked to another QRole user
    assert.equal(checkCleanupStillDue({ ...base, meta: null }).veto, 'gone');
    assert.equal(checkCleanupStillDue({ ...base, meta: { ...lapsedMeta, oauthUserId: 'u-2' } }).veto, 'gone');
    assert.equal(checkCleanupStillDue({ ...base, meta: { ...lapsedMeta, oauthUserId: null } }).veto, 'gone');
    // Admin switched cleanup (or the membership gate) off while the job was running
    assert.equal(checkCleanupStillDue({ ...base, lifecycle: { ...lifecycle, expiredCleanup: { enabled: false, afterDays: 90 } } }).veto, 'cleanup_disabled');
    assert.equal(checkCleanupStillDue({ ...base, lifecycle: { ...lifecycle, requireMembership: false } }).veto, 'cleanup_disabled');
    // afterDays raised meanwhile
    assert.equal(checkCleanupStillDue({ ...base, lifecycle: { ...lifecycle, expiredCleanup: { enabled: true, afterDays: 365 } } }).veto, 'not_due');
});

// ---------------------------------------------------------------------------
// sanitizeMeta
// ---------------------------------------------------------------------------

test('sanitizeMeta strips the refresh token without touching the stored object', () => {
    const meta = memberMeta();
    const clean = sanitizeMeta(meta);
    assert.equal(clean.qroleRefreshToken, undefined);
    assert.equal('qroleRefreshToken' in clean, false);
    assert.equal(clean.qroleRefreshTokenExpiresAt, meta.qroleRefreshTokenExpiresAt, 'the expiry is not secret');
    assert.equal(clean.qroleTier, 'vip');
    assert.equal(meta.qroleRefreshToken, 'v1.x.y.z', 'input not mutated');
    assert.equal(sanitizeMeta(null), null);
    assert.equal(sanitizeMeta(undefined), undefined);
});
