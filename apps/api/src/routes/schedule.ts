import { Router, type RequestHandler } from 'express';
import type { ScheduleService } from '@shorts/core';
import { recordAudit } from '../services/audit.service';

/** Phase 8: publish calendar. */
export function createScheduleRoutes(schedule: ScheduleService, adminOnly: RequestHandler) {
  const router = Router();
  router.get('/schedule', async (req, res) => {
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
    res.json(await schedule.list(days));
  });
  /** Move a Short to another slot. Body: { goLiveAt: ISO date }. */
  router.put('/clips/:id/schedule', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    const at = new Date(String(req.body?.goLiveAt ?? ''));
    await schedule.reschedule(id, at);
    await recordAudit(req, { action: 'clip.reschedule', entityType: 'GeneratedClip', entityId: id, metadata: { goLiveAt: at.toISOString() } });
    res.json({ ok: true });
  });
  router.post('/clips/:id/publish-now', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    await schedule.publishNow(id);
    await recordAudit(req, { action: 'clip.publish_now', entityType: 'GeneratedClip', entityId: id });
    res.json({ ok: true });
  });
  return router;
}
