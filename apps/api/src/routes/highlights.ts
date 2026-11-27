import { Router, type RequestHandler } from 'express';
import { DomainError, enqueueRender, type CandidateService, type ClipService, type LiveSessionService } from '@shorts/core';
import type { QueueRegistry } from '@shorts/queue';
import { LiveSessionModel } from '@shorts/database';
import { LocalObjectStorage, type ObjectStorage } from '@shorts/integrations';
import { candidateUpdateSchema, transcriptQuerySchema, type ClipMediaDTO, type SourcePreviewDTO } from '@shorts/shared-types';
import { parseOrThrow } from '../errors';
import { recordAudit } from '../services/audit.service';

const PREVIEW_TTL_SECONDS = 2 * 60 * 60;

/** Phase 4 read/review endpoints mounted under /live-sessions/:id/… */
export function createSessionAnalysisRoutes(sessions: LiveSessionService, candidates: CandidateService, storage: ObjectStorage): Router {
  const router = Router();

  router.get('/:id/highlights', async (req, res) => {
    res.json({ items: await candidates.listForSession(String(req.params.id)) });
  });

  router.get('/:id/transcript', async (req, res) => {
    const q = parseOrThrow(transcriptQuerySchema, req.query);
    res.json(await candidates.transcript(String(req.params.id), q.from, q.to));
  });

  /** Short-lived URL for previewing the stored recording in the browser. */
  router.get('/:id/source/preview', async (req, res) => {
    const id = String(req.params.id);
    await sessions.get(id); // 404s for unknown ids
    const s = await LiveSessionModel.findById(id).select('sourceMedia.storageKey').lean();
    const key = s?.sourceMedia?.storageKey;
    if (!key) throw new DomainError('SOURCE_NOT_AVAILABLE', 'The recording is not stored (missing or expired)', 404);
    const body: SourcePreviewDTO =
      storage instanceof LocalObjectStorage
        ? { url: `/api/v1/live-sessions/${id}/source/file`, expiresAt: null }
        : { url: await storage.signedReadUrl(key, PREVIEW_TTL_SECONDS), expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString() };
    res.json(body);
  });

  /** Local-storage only: stream the recording with HTTP range support (video seeking). */
  router.get('/:id/source/file', async (req, res) => {
    if (!(storage instanceof LocalObjectStorage)) throw DomainError.notFound('File');
    const s = await LiveSessionModel.findById(String(req.params.id)).select('sourceMedia.storageKey').lean().catch(() => null);
    const key = s?.sourceMedia?.storageKey;
    if (!key) throw DomainError.notFound('File');
    res.sendFile(storage.pathFor(key), { headers: { 'Cache-Control': 'private, max-age=300' } });
  });

  return router;
}

/** /api/v1/highlights/:id — Clip Studio edits. */
export function createHighlightRoutes(candidates: CandidateService, adminOnly: RequestHandler): Router {
  const router = Router();
  router.patch('/:id', adminOnly, async (req, res) => {
    const input = parseOrThrow(candidateUpdateSchema, req.body);
    const updated = await candidates.update(String(req.params.id), input);
    await recordAudit(req, { action: 'highlight.update', entityType: 'HighlightCandidate', entityId: updated.id, metadata: input });
    res.json(updated);
  });
  return router;
}

const CLIP_URL_TTL_SECONDS = 2 * 60 * 60;

/** Phase 5: rendered Shorts. */
export function createClipRoutes(clips: ClipService, storage: ObjectStorage, queues: QueueRegistry, sessions: LiveSessionService, adminOnly: RequestHandler) {
  const sessionRouter = Router();
  sessionRouter.get('/:id/clips', async (req, res) => {
    res.json({ items: await clips.listForSession(String(req.params.id)) });
  });
  /** Render (or re-render after trims) every selected highlight of the session. */
  sessionRouter.post('/:id/render', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    await sessions.get(id);
    const force = req.body?.force === true;
    // fresh = delete the unpublished Shorts first and regenerate them (optionally in another layout).
    const fresh = req.body?.fresh === true;
    const modes = ['CENTER_CROP', 'BLUR_FIT', 'FACECAM_SPLIT', 'GAMEPLAY'];
    const mode = req.body?.reframingMode;
    if (mode !== undefined && mode !== null && !modes.includes(mode)) throw new DomainError('VALIDATION_ERROR', `reframingMode must be one of ${modes.join(', ')}`, 400);
    const styles = ['AUTO', 'REACTION', 'GAMEPLAY', 'CLEAN', 'STORY'];
    const style = req.body?.shortStyle;
    if (style !== undefined && style !== null && !styles.includes(style)) throw new DomainError('VALIDATION_ERROR', `shortStyle must be one of ${styles.join(', ')}`, 400);
    let reset: { removed: number; kept: number } | null = null;
    if (fresh) reset = await clips.resetSession(id, mode === undefined ? undefined : mode, style === undefined ? undefined : style);
    await enqueueRender(queues, id, `manual-${Date.now()}`, force || fresh);
    await recordAudit(req, { action: 'session.render', entityType: 'LiveSession', entityId: id, metadata: { force, fresh, mode, style, reset } });
    res.status(202).json({ queued: true, ...(reset ?? {}) });
  });

  const clipRouter = Router();
  clipRouter.get('/:id/media', async (req, res) => {
    const id = String(req.params.id);
    const body: ClipMediaDTO = await clips.mediaUrls(id, CLIP_URL_TTL_SECONDS, (kind) => `/api/v1/clips/${id}/file/${kind}`);
    res.json(body);
  });
  /** Local-storage only: serve the rendered file (range requests supported). */
  clipRouter.get('/:id/file/:kind', async (req, res) => {
    if (!(storage instanceof LocalObjectStorage)) throw DomainError.notFound('File');
    const c = await clips.get(String(req.params.id));
    const key = req.params.kind === 'video' ? c.storageKey : req.params.kind === 'thumbnail' ? c.thumbnailKey : null;
    if (!key) throw DomainError.notFound('File');
    res.sendFile(storage.pathFor(key), { headers: { 'Cache-Control': 'private, max-age=300' } });
  });
  return { sessionRouter, clipRouter };
}
