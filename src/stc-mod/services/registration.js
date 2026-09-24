/**
 * SillyTavernchat Module - Registration switch
 * Admin-controlled toggle (config.yaml `enableRegistration`) for opening/closing self-registration.
 */
import { getStcConfig } from '../config.js';

export const REGISTRATION_CLOSED_MESSAGE = '管理员已关闭注册';

/**
 * Whether self-registration is open. Defaults to open when the key is missing.
 * When closed, only QRole members may still be auto-provisioned on first QRole login.
 * @returns {boolean}
 */
export function isRegistrationEnabled() {
    return getStcConfig('enableRegistration', true) !== false;
}

/**
 * Send the standard "registration closed" API error.
 * @param {import('express').Response} res
 */
export function sendRegistrationClosed(res) {
    return res.status(403).json({ error: REGISTRATION_CLOSED_MESSAGE, code: 'REGISTRATION_CLOSED' });
}
