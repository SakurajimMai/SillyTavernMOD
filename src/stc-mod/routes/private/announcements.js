/**
 * SillyTavernchat Module - Announcements Management (Admin)
 * Stores: services/announcements.js. A store that cannot be read answers 503 STORE_UNAVAILABLE.
 */
import express from 'express';
import crypto from 'node:crypto';
import { requireAdminMiddleware } from '../../../users.js';
import { getAnnouncementStore, loadAnnouncements } from '../../services/announcements.js';
import { respondStoreError } from '../../services/json-store.js';

export const router = express.Router();

// Get current active announcements (for logged-in users)
router.get('/current', (req, res) => {
    try {
        const announcements = loadAnnouncements('main').filter(a => a.enabled);
        res.json(announcements);
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: list all announcements
router.get('/list', requireAdminMiddleware, (req, res) => {
    try {
        res.json(loadAnnouncements(req.query.type));
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: create announcement
router.post('/create', requireAdminMiddleware, (req, res) => {
    try {
        const { title, content, category, type: announcementType, enabled } = req.body;
        const newAnn = {
            id: crypto.randomUUID(),
            title: title || '',
            content: content || '',
            category: category || 'general',
            type: announcementType || 'info',
            enabled: enabled !== false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            createdBy: req.user?.profile?.handle || 'admin',
        };
        getAnnouncementStore(req.query.type).update((announcements) => {
            announcements.push(newAnn);
        });
        res.json({ success: true, announcement: newAnn });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: update announcement
router.post('/update', requireAdminMiddleware, (req, res) => {
    try {
        const { id, title, content, category, type: announcementType, enabled } = req.body;
        const updated = getAnnouncementStore(req.query.type).update((announcements) => {
            const idx = announcements.findIndex(a => a.id === id);
            if (idx === -1) return null;

            if (title !== undefined) announcements[idx].title = title;
            if (content !== undefined) announcements[idx].content = content;
            if (category !== undefined) announcements[idx].category = category;
            if (announcementType !== undefined) announcements[idx].type = announcementType;
            if (enabled !== undefined) announcements[idx].enabled = enabled;
            announcements[idx].updatedAt = Date.now();
            return announcements[idx];
        });
        if (!updated) return res.status(404).json({ error: '公告不存在' });
        res.json({ success: true, announcement: updated });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});

// Admin: delete announcement
router.post('/delete', requireAdminMiddleware, (req, res) => {
    try {
        const { id } = req.body;
        const deleted = getAnnouncementStore(req.query.type).update((announcements) => {
            const idx = announcements.findIndex(a => a.id === id);
            if (idx === -1) return false;
            // Same as the former filter(): every entry with this id goes
            for (let i = announcements.length - 1; i >= 0; i--) {
                if (announcements[i].id === id) announcements.splice(i, 1);
            }
            return true;
        });
        if (!deleted) return res.status(404).json({ error: '公告不存在' });
        res.json({ success: true });
    } catch (error) {
        if (respondStoreError(req, res, error)) return;
        res.status(500).json({ error: error.message });
    }
});
