import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Router, type RequestHandler } from 'express';
import { DomainError, VIDEO_EXTENSIONS, incomingDir, type LiveSessionService, type SettingsService } from '@shorts/core';
import { sessionListQuerySchema } from '@shorts/shared-types';
import { parseOrThrow } from '../errors';
import { recordAudit } from '../services/audit.service';

/** /api/v1/live-sessions (spec §12). */
export function createSessionRoutes(sessions: LiveSessionService, settings: SettingsService, storageDir: string, adminOnly: RequestHandler): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await sessions.list(parseOrThrow(sessionListQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    res.json(await sessions.get(String(req.params.id)));
  });

  router.post('/:id/reprocess', adminOnly, async (req, res) => {
    const retranscribe = req.body?.retranscribe === true;
    const session = await sessions.reprocess(String(req.params.id), { retranscribe });
    await recordAudit(req, { action: 'session.reprocess', entityType: 'LiveSession', entityId: session.id, metadata: { round: session.reprocessCount, retranscribe } });
    res.status(202).json(session);
  });

  /**
   * Manual source upload (Phase 3). Raw body = the video file; the file name
   * travels in `X-Upload-Filename`. Streams to disk (never buffered in memory),
   * enforces the size limit while streaming, then queues acquisition.
   */
  router.post('/:id/source', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    const session = await sessions.get(id);
    if (session.status === 'LIVE' || session.status === 'DETECTED') {
      throw new DomainError('SESSION_STILL_LIVE', 'Upload the recording after the stream has ended', 409);
    }
    const ext = path.extname(decodeURIComponent(String(req.headers['x-upload-filename'] ?? ''))).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(ext)) {
      throw new DomainError('UNSUPPORTED_FILE_TYPE', `Unsupported file type. Allowed: ${VIDEO_EXTENSIONS.join(', ')}`, 415);
    }
    const maxBytes = (await settings.getValues()).values.processing.maxSourceFileSizeMb * 1024 * 1024;
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) throw new DomainError('FILE_TOO_LARGE', 'File exceeds the size limit in Settings → Processing', 413);

    const dir = incomingDir(storageDir);
    await fsp.mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, `${id}${ext}`);
    const partPath = `${finalPath}.part`;
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        cb(received > maxBytes ? new DomainError('FILE_TOO_LARGE', 'File exceeds the size limit in Settings → Processing', 413) : null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(partPath));
      if (received === 0) throw new DomainError('EMPTY_UPLOAD', 'The uploaded file is empty', 400);
      await fsp.rename(partPath, finalPath);
    } catch (err) {
      await fsp.rm(partPath, { force: true });
      throw err;
    }

    let updated;
    try {
      updated = await sessions.reprocess(id);
    } catch (err) {
      // Acquisition already queued: it will find the new file.
      if (!(err instanceof DomainError && err.code === 'ALREADY_QUEUED')) throw err;
      updated = await sessions.get(id);
    }
    await recordAudit(req, { action: 'session.upload_source', entityType: 'LiveSession', entityId: id, metadata: { bytes: received, ext } });
    res.status(202).json(updated);
  });

  return router;
}
