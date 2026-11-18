import { Router } from 'express';
import { z } from 'zod';
import type { MockYouTubeProvider } from '@shorts/integrations';
import { mockGoLiveSchema } from '@shorts/shared-types';
import { AppError, parseOrThrow } from '../errors';
import { recordAudit } from '../services/audit.service';

const endSchema = z.object({ mode: z.enum(['clean', 'ambiguous', 'vanish']).default('clean') }).strict();

/**
 * Dev-only controls for the mock YouTube provider, so the whole live
 * lifecycle can be exercised without real streamers (spec §21). Mounted only
 * when YOUTUBE_METADATA_PROVIDER resolves to `mock`; admin-only.
 */
export function createMockYouTubeRoutes(mock: MockYouTubeProvider): Router {
  const router = Router();

  router.get('/channels', async (_req, res) => {
    res.json({ items: await mock.listChannels() });
  });

  router.post('/channels/:channelId/go-live', async (req, res) => {
    const { title } = parseOrThrow(mockGoLiveSchema, req.body ?? {});
    try {
      const result = await mock.goLive(String(req.params.channelId), title);
      await recordAudit(req, { action: 'dev.mock.go_live', metadata: { channelId: String(req.params.channelId), ...result } });
      res.status(201).json(result);
    } catch {
      throw AppError.notFound('Mock channel not found — register it as a streamer first');
    }
  });

  router.post('/channels/:channelId/end-live', async (req, res) => {
    const { mode } = parseOrThrow(endSchema, req.body ?? {});
    const result = await mock.endLive(String(req.params.channelId), mode);
    if (!result) throw AppError.conflict('This mock channel is not live');
    await recordAudit(req, { action: 'dev.mock.end_live', metadata: { channelId: String(req.params.channelId), mode, ...result } });
    res.json({ ...result, mode });
  });

  return router;
}
