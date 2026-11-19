import { Router, type RequestHandler } from 'express';
import { DomainError, toClipDTO, type ClipService, type PublishService, type YouTubeAccountService } from '@shorts/core';
import { YouTubePublishError } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { clipMetadataSchema } from '@shorts/shared-types';
import { parseOrThrow } from '../errors';
import { recordAudit } from '../services/audit.service';

/**
 * OAuth callback. Public on purpose: Google redirects the browser here
 * cross-site, so the SameSite=Strict session cookie is not sent. The
 * single-use `state` (bound to the admin who started the flow) is the proof.
 */
export function createYouTubeCallbackRoute(account: YouTubeAccountService, webOrigin: string, logger: Logger): RequestHandler {
  return async (req, res) => {
    const back = (q: Record<string, string>) => res.redirect(303, `${webOrigin}/settings?${new URLSearchParams(q)}`);
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) return back({ youtube_error: error === 'access_denied' ? 'Access was not granted.' : `Google returned: ${error}` });
    if (!code || !state) return back({ youtube_error: 'Missing code or state in the callback.' });
    try {
      const ch = await account.completeConnect(state, code);
      return back({ youtube: 'connected', channel: ch.channelTitle });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'YouTube connect failed');
      const msg = err instanceof DomainError || err instanceof YouTubePublishError ? err.message : 'Connecting the channel failed. Check the API logs.';
      return back({ youtube_error: msg });
    }
  };
}

/** /api/v1/integrations/youtube — connect / disconnect the central channel (ADMIN). */
export function createYouTubeRoutes(account: YouTubeAccountService, adminOnly: RequestHandler): Router {
  const router = Router();
  router.get('/connect', adminOnly, async (req, res) => {
    res.json({ url: await account.startConnect(req.user!.id) });
  });
  router.delete('/', adminOnly, async (req, res) => {
    await account.disconnect();
    await recordAudit(req, { action: 'youtube.disconnect', entityType: 'IntegrationCredential' });
    res.status(204).end();
  });
  return router;
}

/** /api/v1/clips/:id — metadata, approval and upload (Phase 6). */
export function createPublishRoutes(publish: PublishService, clips: ClipService, adminOnly: RequestHandler): Router {
  const router = Router();
  const dto = async (id: string) => toClipDTO(await clips.get(id));

  router.patch('/:id', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    const input = parseOrThrow(clipMetadataSchema, req.body);
    await publish.updateMetadata(id, input);
    await recordAudit(req, { action: 'clip.metadata.update', entityType: 'GeneratedClip', entityId: id });
    res.json(await dto(id));
  });

  router.post('/:id/metadata', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    await clips.get(id);
    try {
      await publish.generateMetadata(id);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError('METADATA_FAILED', `Could not generate metadata: ${(err as Error).message}`, 502);
    }
    await recordAudit(req, { action: 'clip.metadata.generate', entityType: 'GeneratedClip', entityId: id });
    res.json(await dto(id));
  });

  /** Approve and queue the upload; also retries a failed upload. */
  router.post('/:id/approve', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    await publish.approve(id, req.user!.id);
    await recordAudit(req, { action: 'clip.approve', entityType: 'GeneratedClip', entityId: id });
    res.status(202).json(await dto(id));
  });

  router.post('/:id/reject', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    await publish.reject(id, req.user!.id);
    await recordAudit(req, { action: 'clip.reject', entityType: 'GeneratedClip', entityId: id });
    res.json(await dto(id));
  });
  return router;
}
