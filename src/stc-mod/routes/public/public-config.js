/**
 * SillyTavernchat Module - Public Config Route
 * Returns feature flags for frontend to determine which pages/features are available.
 */
import express from 'express';
import { getStcConfig } from '../../config.js';
import { isEmailServiceAvailable } from '../../services/email-service.js';
import { isRegistrationEnabled } from '../../services/registration.js';

export const router = express.Router();

router.get('/public-pages', (req, res) => {
    res.json({
        enableRegistration: isRegistrationEnabled(),
        enableInvitationCodes: !!getStcConfig('enableInvitationCodes', false),
        enableEmailVerification: isEmailServiceAvailable(),
        enableOAuthGithub: !!getStcConfig('oauth.github.enabled', false),
        enableOAuthDiscord: !!getStcConfig('oauth.discord.enabled', false),
        enableOAuthLinuxdo: !!getStcConfig('oauth.linuxdo.enabled', false),
        enableOAuthQrole: !!(getStcConfig('oauth.qrole.enabled', false) && getStcConfig('oauth.qrole.clientId', '')),
        qroleRequireMembership: getStcConfig('oauth.qrole.requireMembership', true) !== false,
        purchaseLink: getStcConfig('purchaseLink', ''),
    });
});
