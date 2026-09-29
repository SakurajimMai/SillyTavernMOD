/**
 * SillyTavernchat Module - Default Config Template (Admin)
 * A template store that cannot be read answers 503 STORE_UNAVAILABLE (never "no template").
 */
import express from 'express';
import { requireAdminMiddleware } from '../../../users.js';
import { saveTemplate, getTemplateMeta, deleteTemplate } from '../../services/default-template.js';
import { respondStoreError } from '../../services/json-store.js';

export const router = express.Router();

router.get('/template', requireAdminMiddleware, (req, res) => {
    try {
        const meta = getTemplateMeta();
        res.json(meta || { exists: false });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

router.post('/template', requireAdminMiddleware, (req, res) => {
    try {
        const { sourceHandle, options } = req.body;
        if (!sourceHandle) return res.status(400).json({ error: '缺少源用户标识' });
        const meta = saveTemplate(sourceHandle, options || {});
        res.json({ success: true, meta });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

router.post('/template/delete', requireAdminMiddleware, (req, res) => {
    try {
        deleteTemplate();
        res.json({ success: true });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});
