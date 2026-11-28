import { Router, type RequestHandler } from 'express';
import type { CategoryService } from '@shorts/core';
import { recordAudit } from '../services/audit.service';

/** Phase 10: category presets, a session's category, and results per category. */
export function createCategoryRoutes(categories: CategoryService, adminOnly: RequestHandler) {
  const router = Router();
  router.get('/categories', async (_req, res) => {
    res.json({ items: await categories.list() });
  });
  router.get('/categories/stats', async (_req, res) => {
    res.json({ items: await categories.stats() });
  });
  router.put('/categories/:category', adminOnly, async (req, res) => {
    const out = await categories.update(String(req.params.category), req.body ?? {});
    await recordAudit(req, { action: 'category.update', entityType: 'CategoryPreset', entityId: out.category, metadata: req.body });
    res.json(out);
  });
  router.put('/sessions/:id/category', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    await categories.setSessionCategory(id, String(req.body?.category ?? ''));
    await recordAudit(req, { action: 'session.category', entityType: 'LiveSession', entityId: id, metadata: { category: req.body?.category } });
    res.json({ category: req.body.category });
  });
  return router;
}
