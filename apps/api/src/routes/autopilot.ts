import { Router, type RequestHandler } from 'express';
import type { AutopilotService } from '@shorts/core';
import { recordAudit } from '../services/audit.service';

/** Phase 9: autopilot status, decision log, pause / resume. */
export function createAutopilotRoutes(autopilot: AutopilotService, adminOnly: RequestHandler) {
  const router = Router();
  router.get('/autopilot', async (req, res) => {
    const limit = Number(req.query.limit) || 100;
    const [status, events] = await Promise.all([autopilot.status(), autopilot.events(limit)]);
    res.json({ status, events });
  });
  router.post('/autopilot/pause', adminOnly, async (req, res) => {
    const who = req.user?.email ?? 'admin';
    await autopilot.pause('paused by you', who);
    await recordAudit(req, { action: 'autopilot.pause' });
    res.json(await autopilot.status());
  });
  router.post('/autopilot/resume', adminOnly, async (req, res) => {
    const who = req.user?.email ?? 'admin';
    await autopilot.resume(who);
    await recordAudit(req, { action: 'autopilot.resume' });
    res.json(await autopilot.status());
  });
  return router;
}
