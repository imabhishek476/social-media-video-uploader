import { Router, type RequestHandler } from 'express';
import type { ChannelService } from '@shorts/core';
import { createStreamerSchema, monitoringToggleSchema, streamerListQuerySchema, updateStreamerSchema } from '@shorts/shared-types';
import { parseOrThrow } from '../errors';
import { recordAudit } from '../services/audit.service';

/** /api/v1/streamers (spec §12). Reads: any signed-in user. Writes: admins. */
export function createStreamerRoutes(channels: ChannelService, adminOnly: RequestHandler): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await channels.list(parseOrThrow(streamerListQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    res.json(await channels.get(String(req.params.id)));
  });

  router.post('/', adminOnly, async (req, res) => {
    const input = parseOrThrow(createStreamerSchema, req.body);
    const { streamer, restored } = await channels.register(input);
    await recordAudit(req, {
      action: restored ? 'streamer.restore' : 'streamer.create',
      entityType: 'StreamerChannel',
      entityId: streamer.id,
      metadata: { channelId: streamer.channelId, input: input.channel },
    });
    res.status(restored ? 200 : 201).json(streamer);
  });

  router.patch('/:id', adminOnly, async (req, res) => {
    const patch = parseOrThrow(updateStreamerSchema, req.body);
    const streamer = await channels.update(String(req.params.id), patch);
    await recordAudit(req, { action: 'streamer.update', entityType: 'StreamerChannel', entityId: streamer.id, metadata: { fields: Object.keys(patch) } });
    res.json(streamer);
  });

  router.patch('/:id/monitoring', adminOnly, async (req, res) => {
    const { enabled } = parseOrThrow(monitoringToggleSchema, req.body);
    const streamer = await channels.setMonitoring(String(req.params.id), enabled);
    await recordAudit(req, { action: enabled ? 'streamer.resume' : 'streamer.pause', entityType: 'StreamerChannel', entityId: streamer.id });
    res.json(streamer);
  });

  router.post('/:id/check', adminOnly, async (req, res) => {
    res.json(await channels.checkNow(String(req.params.id)));
  });

  router.delete('/:id', adminOnly, async (req, res) => {
    await channels.remove(String(req.params.id));
    await recordAudit(req, { action: 'streamer.remove', entityType: 'StreamerChannel', entityId: String(req.params.id) });
    res.status(204).end();
  });

  return router;
}
