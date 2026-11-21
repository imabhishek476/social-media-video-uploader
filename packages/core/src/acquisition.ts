import fsp from 'node:fs/promises';
import path from 'node:path';
import { LiveSessionModel } from '@shorts/database';
import type { ObjectStorage } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { ProcessingStatus, SessionStatus, SourceMediaStatus } from '@shorts/shared-types';
import { MediaProbeError, probeMedia, validateMedia } from './ffprobe';
import type { SettingsService } from './settings';
import type { VideoSourceProvider } from './source-provider';

export interface AcquisitionDeps {
  settings: SettingsService;
  source: VideoSourceProvider;
  storage: ObjectStorage;
  /** Local scratch space for validation (`<storageDir>/tmp`). */
  tempDir: string;
  logger?: Logger;
}

export type AcquisitionOutcome = 'READY' | 'ALREADY_READY' | 'UNAVAILABLE' | 'REJECTED' | 'SKIPPED';

const mimeFor = (ext: string) =>
  ({ '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ts': 'video/mp2t', '.flv': 'video/x-flv' })[ext] ??
  'application/octet-stream';

export const rawKey = (sessionId: string, ext: string) => `raw/${sessionId}/source${ext}`;

/**
 * Source acquisition (spec §6 Workflow D). Idempotent: re-running for a
 * session that already has a stored, valid source is a no-op.
 *
 * Outcomes that are not crashes (nothing to retry automatically):
 *  - UNAVAILABLE: no recording found yet → SOURCE_UNAVAILABLE; provide a file, then Reprocess
 *  - REJECTED:    file found but invalid/over limits → SOURCE_UNAVAILABLE with the reason
 */
export class AcquisitionService {
  constructor(private readonly deps: AcquisitionDeps) {}

  async acquire(sessionId: string, onProgress?: (pct: number) => Promise<void>): Promise<AcquisitionOutcome> {
    const { source, storage, logger } = this.deps;
    const session = await LiveSessionModel.findById(sessionId).lean();
    if (!session) return 'SKIPPED';
    if (session.status === SessionStatus.CANCELLED) return 'SKIPPED';

    if (session.sourceMedia?.status === SourceMediaStatus.READY && session.sourceMedia.storageKey && (await storage.exists(session.sourceMedia.storageKey))) {
      return 'ALREADY_READY';
    }

    await LiveSessionModel.updateOne(
      { _id: sessionId },
      { $set: { status: SessionStatus.SOURCE_PENDING, processingStatus: ProcessingStatus.RUNNING, 'sourceMedia.status': SourceMediaStatus.DOWNLOADING, 'sourceMedia.provider': source.name, 'sourceMedia.lastError': null, lastError: null } },
    );

    const ref = await source.locate({ id: sessionId, broadcastId: session.broadcastId });
    if (!ref) {
      await this.markUnavailable(
        sessionId,
        SourceMediaStatus.UNAVAILABLE,
        `No recording found yet. Upload it on the session page, or put it in the storage inbox as incoming/${session.broadcastId}.mp4; it is picked up automatically within a few minutes.`,
      );
      return 'UNAVAILABLE';
    }

    const ext = path.extname(ref.localPath).toLowerCase();
    try {
      const info = await probeMedia(ref.localPath);
      const { processing } = (await this.deps.settings.getValues()).values;
      const problem = validateMedia(info, { maxDurationMinutes: processing.maxSourceDurationMinutes, maxFileSizeMb: processing.maxSourceFileSizeMb });
      if (problem) {
        await this.markUnavailable(sessionId, SourceMediaStatus.FAILED, problem);
        if (ref.consume) await fsp.rm(ref.localPath, { force: true }); // don't re-trigger on a rejected file
        await ref.release?.();
        return 'REJECTED';
      }
      await onProgress?.(30);

      const key = rawKey(sessionId, ext);
      const { sizeBytes } = await storage.upload(key, ref.localPath, mimeFor(ext));
      if (sizeBytes !== info.sizeBytes) throw new Error(`Upload size mismatch (${sizeBytes} vs ${info.sizeBytes} bytes)`);
      await onProgress?.(90);

      await LiveSessionModel.updateOne(
        { _id: sessionId },
        {
          $set: {
            status: SessionStatus.SOURCE_READY,
            processingStatus: ProcessingStatus.QUEUED,
            durationSeconds: session.durationSeconds ?? Math.round(info.durationSeconds),
            sourceMedia: {
              provider: source.name,
              status: SourceMediaStatus.READY,
              storageKey: key,
              fileSizeBytes: sizeBytes,
              durationSeconds: Math.round(info.durationSeconds),
              width: info.width,
              height: info.height,
              frameRate: info.frameRate,
              hasAudio: info.hasAudio,
              videoCodec: info.videoCodec,
              readyAt: new Date(),
              lastError: null,
            },
          },
        },
      );
      // Only after the object is stored and recorded is it safe to drop the local copy and the original.
      if (ref.consume) await fsp.rm(ref.localPath, { force: true });
      await ref.release?.();
      logger?.info({ liveSessionId: sessionId, key, sizeBytes, durationSeconds: Math.round(info.durationSeconds) }, 'Source media ready');
      return 'READY';
    } catch (err) {
      if (err instanceof MediaProbeError && err.code === 'CORRUPT_MEDIA') {
        await this.markUnavailable(sessionId, SourceMediaStatus.FAILED, err.message);
        if (ref.consume) await fsp.rm(ref.localPath, { force: true });
        await ref.release?.();
        return 'REJECTED';
      }
      // Transient (network, storage, missing ffprobe): leave the file in place and let the queue retry.
      await LiveSessionModel.updateOne({ _id: sessionId }, { $set: { 'sourceMedia.lastError': (err as Error).message.slice(0, 500) } });
      throw err;
    }
  }

  private async markUnavailable(sessionId: string, mediaStatus: string, reason: string) {
    await LiveSessionModel.updateOne(
      { _id: sessionId },
      { $set: { status: SessionStatus.SOURCE_UNAVAILABLE, processingStatus: ProcessingStatus.FAILED, 'sourceMedia.status': mediaStatus, 'sourceMedia.lastError': reason, lastError: reason } },
    );
    this.deps.logger?.warn({ liveSessionId: sessionId, reason }, 'Source media unavailable');
  }
}

/**
 * Retention sweep (spec §19). Removes raw recordings older than
 * `retention.sourceDays` (0 = keep forever). GCS lifecycle rules are the
 * backstop; this keeps the database in sync and frees space promptly.
 */
export async function sweepExpiredSources(
  deps: { settings: SettingsService; storage: ObjectStorage; logger?: Logger },
  now = new Date(),
): Promise<{ deleted: number }> {
  const { retention } = (await deps.settings.getValues()).values;
  if (retention.sourceDays <= 0) return { deleted: 0 };
  const cutoff = new Date(now.getTime() - retention.sourceDays * 86_400_000);
  const expired = await LiveSessionModel.find({ 'sourceMedia.status': SourceMediaStatus.READY, 'sourceMedia.readyAt': { $lt: cutoff }, 'sourceMedia.storageKey': { $ne: null } })
    .select('sourceMedia.storageKey')
    .limit(200)
    .lean();
  let deleted = 0;
  for (const s of expired) {
    try {
      await deps.storage.delete(s.sourceMedia!.storageKey!);
      await LiveSessionModel.updateOne({ _id: s._id }, { $set: { 'sourceMedia.status': SourceMediaStatus.EXPIRED, 'sourceMedia.storageKey': null } });
      deleted++;
    } catch (err) {
      deps.logger?.warn({ err: (err as Error).message, liveSessionId: String(s._id) }, 'Failed to delete expired source');
    }
  }
  if (deleted) deps.logger?.info({ deleted }, 'Expired source recordings deleted');
  return { deleted };
}
