import { Router, type RequestHandler } from 'express';
import type { LiveSessionService } from '@shorts/core';
import { sessionListQuerySchema } from '@shorts/shared-types';
import { parseOrThrow } from '../errors';
import { recordAudit } from '../services/audit.service';

/** /api/v1/live-sessions (spec §12). */
export function createSessionRoutes(sessions: LiveSessionService, adminOnly: RequestHandler): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await sessions.list(parseOrThrow(sessionListQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    res.json(await sessions.get(String(req.params.id)));
  });

  router.post('/:id/reprocess', adminOnly, async (req, res) => {
    const session = await sessions.reprocess(String(req.params.id));
    await recordAudit(req, { action: 'session.reprocess', entityType: 'LiveSession', entityId: session.id, metadata: { round: session.reprocessCount } });
    res.status(202).json(session);
  });

  return router;
}
