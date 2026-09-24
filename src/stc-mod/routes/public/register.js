/**
 * SillyTavernchat Module - Registration Route
 * Handles user registration by calling the official SillyTavern /api/users/create API internally.
 */
import express from 'express';
import crypto from 'node:crypto';
import storage from 'node-persist';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { toKey } from '../../../users.js';
import { getIpAddress, retryAfter } from '../../../express-common.js';
import { getConfigValue } from '../../../util.js';
import { getStcConfig } from '../../config.js';
import { setUserMeta, findUserByEmail, isUserExpired } from '../../user-metadata.js';
import { isRegistrationEnabled, sendRegistrationClosed } from '../../services/registration.js';
import * as invitationService from '../../services/invitation-codes.js';
import { isEmailServiceAvailable, sendVerificationCode } from '../../services/email-service.js';
import { applyTemplate, getTemplateMeta } from '../../services/default-template.js';
import { getDefaultLimitMiB, isStorageLimitEnabled } from '../../services/storage-quota.js';
import { createUser, rollbackCreatedUser, WEAK_NAMES } from './register-helper.js';

export const router = express.Router();

const verificationCodes = new Map();
const VERIFICATION_EXPIRY = 5 * 60 * 1000; // 5 minutes

function normalizeHandle(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 32) || 'user';
}

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

// Public renew endpoint: rate limited per IP (same IP source as the official login limiter)
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const renewExpiredLimiter = new RateLimiterMemory({
    points: 10,
    duration: 60,
});
// One answer for "no such user" and "invalid code", so the endpoint is not a handle oracle
const RENEW_INVALID_MESSAGE = '续费失败：用户名或激活码无效';

// Send email verification code
router.post('/send-verification', async (req, res) => {
    try {
        if (!isRegistrationEnabled()) {
            return sendRegistrationClosed(res);
        }

        const { email, userName } = req.body;
        if (!email || !userName) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        if (!isEmailServiceAvailable()) {
            return res.status(400).json({ error: '邮件服务未启用' });
        }

        // Check if email already registered
        if (findUserByEmail(email)) {
            return res.status(400).json({ error: '该邮箱已被注册' });
        }

        const code = crypto.randomInt(100000, 999999).toString();
        verificationCodes.set(email.toLowerCase(), {
            code,
            expiresAt: Date.now() + VERIFICATION_EXPIRY,
            userName,
        });

        const sent = await sendVerificationCode(email, code, userName);
        if (!sent) {
            return res.status(500).json({ error: '验证码发送失败' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[STC-MOD] Send verification error:', error);
        res.status(500).json({ error: '服务器错误' });
    }
});

// User registration
router.post('/register', async (req, res) => {
    try {
        if (!isRegistrationEnabled()) {
            return sendRegistrationClosed(res);
        }

        const { name, password, inviteCode, email, verificationCode } = req.body;

        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return res.status(400).json({ error: '用户名至少需要2个字符' });
        }

        // Local accounts must always have a password (no handle-only login)
        if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
            return res.status(400).json({ error: '密码长度需为 8-128 个字符' });
        }

        const handle = normalizeHandle(name.trim());
        if (WEAK_NAMES.includes(handle)) {
            return res.status(400).json({ error: '该用户名不可用' });
        }

        // Validate invitation code if enabled
        if (invitationService.isEnabled()) {
            if (!inviteCode) {
                return res.status(400).json({ error: '需要邀请码' });
            }
            const validation = invitationService.validateInvitationCode(inviteCode);
            if (!validation.valid) {
                return res.status(400).json({ error: validation.reason });
            }
        }

        // Validate email verification if email service is enabled
        if (isEmailServiceAvailable() && getStcConfig('email.enabled', false)) {
            if (!email || !verificationCode) {
                return res.status(400).json({ error: '需要邮箱验证' });
            }
            const stored = verificationCodes.get(email.toLowerCase());
            if (!stored || stored.code !== verificationCode || Date.now() > stored.expiresAt) {
                return res.status(400).json({ error: '验证码无效或已过期' });
            }
            if (findUserByEmail(email)) {
                return res.status(400).json({ error: '该邮箱已被注册' });
            }
            verificationCodes.delete(email.toLowerCase());
        }

        // Create the account directly in the official user storage
        // (the helper also drops stale metadata left under a re-used handle)
        const createResult = await createUser(handle, name.trim(), password);

        if (!createResult.success) {
            return res.status(400).json({ error: createResult.error || '创建用户失败' });
        }

        // The helper may adjust the handle (slugify); use the one that was actually created
        const newHandle = createResult.handle || handle;

        // Save extended user metadata BEFORE using the invitation code, so that
        // extendExpiration() finds the record and time-limited codes are applied.
        const now = Date.now();
        setUserMeta(newHandle, {
            email: email || null,
            expiresAt: 0,
            createdAt: now,
            lastLoginAt: now,
            lastActiveAt: now,
            inviteCodeUsed: inviteCode || null,
            storageLimitMiB: isStorageLimitEnabled() ? getDefaultLimitMiB() : undefined,
            hasPassword: true,
            passwordAutoGenerated: false,
            registrationMethod: 'local',
        }, { immediate: true });

        // Use invitation code and calculate expiration
        let expiresAt = 0;
        if (invitationService.isEnabled() && inviteCode) {
            const useResult = invitationService.useInvitationCode(inviteCode, newHandle);
            if (!useResult.success) {
                // The code was consumed concurrently after validation: never keep an account
                // that did not pay with a valid code (it would otherwise be permanent).
                await rollbackCreatedUser(newHandle);
                return res.status(400).json({ error: useResult.reason || '邀请码使用失败' });
            }
            expiresAt = useResult.expiresAt ?? 0;
        }

        // Apply default template if exists
        if (getTemplateMeta()) {
            try {
                await applyTemplate(newHandle, { displayName: name.trim() });
            } catch (e) {
                console.error('[STC-MOD] Apply template failed:', e.message);
            }
        }

        res.json({
            success: true,
            handle: newHandle,
            name: name.trim(),
            expiresAt: expiresAt === 0 ? 0 : expiresAt || undefined,
        });
    } catch (error) {
        console.error('[STC-MOD] Registration error:', error);
        res.status(500).json({ error: '注册失败，请稍后重试' });
    }
});

// Renew expired user account with new invitation code
router.post('/renew-expired', async (req, res) => {
    try {
        const { handle, inviteCode } = req.body;
        if (!handle || typeof handle !== 'string' || !inviteCode) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        if (!invitationService.isEnabled()) {
            return res.status(400).json({ error: '邀请码系统未启用' });
        }

        try {
            await renewExpiredLimiter.consume(getIpAddress(req, PREFER_REAL_IP_HEADER));
        } catch (rateLimit) {
            if (!(rateLimit instanceof RateLimiterRes)) throw rateLimit;
            return retryAfter(res, rateLimit).status(429).json({ error: '尝试次数过多，请稍后再试' });
        }

        // Validate the code first, then the account; both failures look the same
        const validation = invitationService.validateInvitationCode(inviteCode);
        if (!validation.valid) {
            return res.status(400).json({ error: RENEW_INVALID_MESSAGE });
        }

        // Never create metadata (or burn a code) for accounts that don't exist, and only renew
        // accounts that actually expired: otherwise anyone could turn a permanent account into
        // an expiring one with a short code
        const user = await storage.getItem(toKey(handle));
        if (!user || !isUserExpired(handle)) {
            return res.status(400).json({ error: RENEW_INVALID_MESSAGE });
        }

        const useResult = invitationService.useInvitationCode(inviteCode, handle);
        if (!useResult.success) {
            return res.status(400).json({ error: '邀请码使用失败' });
        }

        setUserMeta(handle, { expiresAt: useResult.expiresAt ?? 0 });

        res.json({
            success: true,
            expiresAt: useResult.expiresAt ?? 0,
        });
    } catch (error) {
        console.error('[STC-MOD] Renew expired error:', error);
        res.status(500).json({ error: '续费失败' });
    }
});
