/**
 * SillyTavernchat Module - Registration Configuration (Admin)
 * Toggle for self-registration (config.yaml `enableRegistration`).
 */
import express from 'express';
import { requireAdminMiddleware } from '../../../users.js';
import { getStcConfig, setStcConfig } from '../../config.js';
import { isRegistrationEnabled } from '../../services/registration.js';

export const router = express.Router();

// Admin: get registration config
router.get('/config', requireAdminMiddleware, (req, res) => {
    res.json({
        enableRegistration: isRegistrationEnabled(),
        enableInvitationCodes: !!getStcConfig('enableInvitationCodes', false),
    });
});

// Admin: update registration config (only `enableRegistration` is writable here)
router.post('/config', requireAdminMiddleware, (req, res) => {
    try {
        const { enableRegistration } = req.body ?? {};
        if (enableRegistration === undefined) {
            return res.status(400).json({ error: '缺少 enableRegistration 参数' });
        }

        const value = !!enableRegistration;
        if (!setStcConfig('enableRegistration', value)) {
            return res.status(500).json({ error: '保存失败，请检查 config.yaml 写入权限' });
        }

        console.info(`[STC-MOD] Registration ${value ? 'opened' : 'closed'} by admin:`, req.user?.profile?.handle);
        res.json({ success: true, enableRegistration: value });
    } catch (error) {
        console.error('[STC-MOD] Save registration config error:', error);
        res.status(500).json({ error: '保存失败，请检查 config.yaml 写入权限' });
    }
});
