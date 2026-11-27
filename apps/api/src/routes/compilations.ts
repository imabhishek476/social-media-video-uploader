import { Router, type RequestHandler } from 'express';
import type { CompilationService } from '@shorts/core';
import type { QueueRegistry } from '@shorts/queue';
import { JobType, QUEUE_NAMES } from '@shorts/shared-types';
import { recordAudit } from '../services/audit.service';

/** Phase 8.5: weekly "best of" long videos. */
export function createCompilationRoutes(compilations: CompilationService, queues: QueueRegistry, adminOnly: RequestHandler) {
  const router = Router();
  router.get('/compilations', async (_req, res) => {
    res.json({ items: await compilations.list() });
  });
  /** Build this week's compilation now (runs in the worker). */
  router.post('/compilations/build', adminOnly, async (req, res) => {
    await queues.get(QUEUE_NAMES[JobType.CLEANUP]).add('weekly-compilation', { force: true }, { jobId: `compilation-manual-${Date.now()}`, removeOnComplete: 50, removeOnFail: 50 });
    await recordAudit(req, { action: 'compilation.build' });
    res.status(202).json({ queued: true });
  });
  return router;
}
