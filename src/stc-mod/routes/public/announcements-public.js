/**
 * SillyTavernchat Module - Public Announcements (Login Page)
 * A store that cannot be read answers 503 STORE_UNAVAILABLE (the login page then shows none),
 * never an empty list.
 */
import express from 'express';
import { loadAnnouncements } from '../../services/announcements.js';
import { respondStoreError } from '../../services/json-store.js';

export const router = express.Router();

router.get('/login/current', (req, res) => {
    try {
        const valid = loadAnnouncements('login').filter(a => a && a.enabled);
        res.json(valid);
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        console.error('[STC-MOD] Get login announcements error:', error);
        res.status(500).json({ error: 'Failed to get announcements' });
    }
});
