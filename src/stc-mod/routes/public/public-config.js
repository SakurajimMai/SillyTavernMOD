/**
 * SillyTavernchat Module - Public Config Route
 * Returns feature flags for frontend to determine which pages/features are available.
 */
import express from 'express';
import { getStcConfig } from '../../config.js';
import { isEmailServiceAvailable } from '../../services/email-service.js';

export const router = express.Router();

router.get('/public-pages', (req, res) => {
    res.json({
        enableInvitationCodes: !!getStcConfig('enableInvitationCodes', false),
        enableEmailVerification: isEmailServiceAvailable(),
        enableOAuthGithub: !!getStcConfig('oauth.github.enabled', false),
        enableOAuthDiscord: !!getStcConfig('oauth.discord.enabled', false),
        enableOAuthLinuxdo: !!getStcConfig('oauth.linuxdo.enabled', false),
        purchaseLink: getStcConfig('purchaseLink', ''),
    });
});
