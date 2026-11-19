import { GeneratedClipModel, LiveSessionModel, ProcessingJobModel, TranscriptChunkModel, TranscriptModel } from '@shorts/database';
import { fetchVideoStats, type Notifier, type ObjectStorage } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import type { Redis } from '@shorts/queue';
import { ApprovalStatus, JobStatus, ProcessingStatus, SessionStatus, SourceMediaStatus, UploadStatus } from '@shorts/shared-types';
import type { YouTubeAccountService } from './publishing';
import type { SettingsService } from './settings';

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Formats operator alerts and never lets a notification failure break a job. */
export class NotificationService {
  constructor(private readonly deps: { notifier: Notifier; webOrigin: string; redis?: Redis; logger?: Logger }) {}

  get channel() {
    return this.deps.notifier.name;
  }

  /** Send, optionally at most once per `onceKey` within `onceForSeconds`. */
  async send(text: string, onceKey?: string, onceForSeconds = 12 * 3600): Promise<void> {
    try {
      if (onceKey && this.deps.redis) {
        const fresh = await this.deps.redis.set(`notify:${onceKey}`, '1', 'EX', onceForSeconds, 'NX');
        if (!fresh) return;
      }
      await this.deps.notifier.send(text);
    } catch (err) {
      this.deps.logger?.warn({ err: (err as Error).message }, 'Notification not sent');
    }
  }

  reviewReady(sessionId: string, streamer: string, count: number) {
    return this.send(`🎬 ${count} Short${count === 1 ? '' : 's'} from ${streamer} ready for review\n${this.deps.webOrigin}/clips?session=${sessionId}`);
  }
  published(title: string, url: string, privacy: string) {
    return this.send(`✅ Published (${privacy}): ${title}\n${url}`);
  }
  uploadFailed(title: string, error: string) {
    return this.send(`❌ Upload failed: ${title}\n${error}`);
  }
  processingFailed(sessionId: string, error: string) {
    return this.send(`⚠️ Processing failed for a session: ${error}\n${this.deps.webOrigin}/sessions?session=${sessionId}`);
  }
  youtubeReconnect(error: string) {
    return this.send(`🔑 YouTube needs to be reconnected: ${error}\n${this.deps.webOrigin}/settings`, 'youtube-reconnect');
  }
  budgetReached(spent: number, budget: number) {
    return this.send(`💸 Monthly AI budget reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Processing paused until next month or a higher budget.\n${this.deps.webOrigin}/settings`, `budget-${new Date().toISOString().slice(0, 7)}`, 31 * 24 * 3600);
  }
}

// ---------------------------------------------------------------------------
// Retention (spec §19)
// ---------------------------------------------------------------------------

/**
 * Delete a stream's raw recording once every Short of it is published or
 * rejected and `sourceAfterDoneDays` have passed (the agreed storage flow).
 */
export async function sweepDoneSources(deps: { settings: SettingsService; storage: ObjectStorage; logger?: Logger }, now = new Date()): Promise<{ deleted: number }> {
  const { retention } = (await deps.settings.getValues()).values;
  if (retention.sourceAfterDoneDays <= 0) return { deleted: 0 };
  const cutoff = new Date(now.getTime() - retention.sourceAfterDoneDays * DAY);
  const groups = await GeneratedClipModel.aggregate<{ _id: unknown; total: number; done: number; lastDone: Date | null }>([
    {
      $group: {
        _id: '$liveSessionId',
        total: { $sum: 1 },
        done: { $sum: { $cond: [{ $or: [{ $eq: ['$uploadStatus', UploadStatus.PUBLISHED] }, { $eq: ['$approvalStatus', ApprovalStatus.REJECTED] }] }, 1, 0] } },
        lastDone: { $max: { $ifNull: ['$publishedAt', '$approvedAt'] } },
      },
    },
    { $match: { $expr: { $and: [{ $gt: ['$total', 0] }, { $eq: ['$total', '$done'] }] }, lastDone: { $lt: cutoff } } },
  ]);
  let deleted = 0;
  for (const g of groups) {
    const s = await LiveSessionModel.findOne({ _id: g._id, 'sourceMedia.status': SourceMediaStatus.READY, 'sourceMedia.storageKey': { $ne: null } }).select('sourceMedia.storageKey').lean();
    if (!s) continue;
    try {
      await deps.storage.delete(s.sourceMedia!.storageKey!);
      await LiveSessionModel.updateOne({ _id: s._id }, { $set: { 'sourceMedia.status': SourceMediaStatus.EXPIRED, 'sourceMedia.storageKey': null } });
      deleted++;
    } catch (err) {
      deps.logger?.warn({ err: (err as Error).message, liveSessionId: String(s._id) }, 'Failed to delete finished source');
    }
  }
  if (deleted) deps.logger?.info({ deleted }, 'Raw recordings of finished streams deleted');
  return { deleted };
}

/** Delete rendered files of published (they live on YouTube) or rejected Shorts after `clipDays`. */
export async function sweepClipFiles(deps: { settings: SettingsService; storage: ObjectStorage; logger?: Logger }, now = new Date()): Promise<{ deleted: number }> {
  const { retention } = (await deps.settings.getValues()).values;
  if (retention.clipDays <= 0) return { deleted: 0 };
  const cutoff = new Date(now.getTime() - retention.clipDays * DAY);
  const clips = await GeneratedClipModel.find({
    filesExpiredAt: null,
    storageKey: { $ne: null },
    $or: [{ uploadStatus: UploadStatus.PUBLISHED, publishedAt: { $lt: cutoff } }, { approvalStatus: ApprovalStatus.REJECTED, updatedAt: { $lt: cutoff } }],
  })
    .limit(500)
    .lean();
  let deleted = 0;
  for (const c of clips) {
    try {
      for (const key of [c.storageKey, c.thumbnailKey, c.subtitleKey]) if (key) await deps.storage.delete(key);
      await GeneratedClipModel.updateOne({ _id: c._id }, { $set: { storageKey: null, thumbnailKey: null, subtitleKey: null, filesExpiredAt: now } });
      deleted++;
    } catch (err) {
      deps.logger?.warn({ err: (err as Error).message, clipId: String(c._id) }, 'Failed to delete clip files');
    }
  }
  if (deleted) deps.logger?.info({ deleted }, 'Expired clip files deleted');
  return { deleted };
}

/** Drop transcripts older than `transcriptDays` (candidates keep their excerpts). */
export async function sweepTranscripts(deps: { settings: SettingsService; logger?: Logger }, now = new Date()): Promise<{ deleted: number }> {
  const { retention } = (await deps.settings.getValues()).values;
  if (retention.transcriptDays <= 0) return { deleted: 0 };
  const old = await TranscriptModel.find({ createdAt: { $lt: new Date(now.getTime() - retention.transcriptDays * DAY) } }).select('_id').limit(200).lean();
  for (const t of old) await Promise.all([TranscriptChunkModel.deleteMany({ transcriptId: t._id }), TranscriptModel.deleteOne({ _id: t._id })]);
  if (old.length) deps.logger?.info({ deleted: old.length }, 'Old transcripts deleted');
  return { deleted: old.length };
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

/**
 * Sessions marked RUNNING whose jobs are all gone (worker killed, Redis
 * flushed) would otherwise spin forever in the UI. After `staleHours`
 * without any live job they are failed with a Reprocess hint.
 */
export async function recoverStuckSessions(deps: { logger?: Logger }, now = new Date(), staleHours = 3): Promise<string[]> {
  const cutoff = new Date(now.getTime() - staleHours * 3600_000);
  const candidates = await LiveSessionModel.find({ processingStatus: ProcessingStatus.RUNNING, updatedAt: { $lt: cutoff } }).select('_id').lean();
  const failed: string[] = [];
  for (const s of candidates) {
    const active = await ProcessingJobModel.exists({
      entityId: s._id,
      status: { $in: [JobStatus.PENDING, JobStatus.RUNNING, JobStatus.RETRYING] },
      updatedAt: { $gte: cutoff },
    });
    if (active) continue;
    const res = await LiveSessionModel.updateOne(
      { _id: s._id, processingStatus: ProcessingStatus.RUNNING },
      { $set: { status: SessionStatus.FAILED, processingStatus: ProcessingStatus.FAILED, processingStage: null, lastError: `Processing stalled (no progress for ${staleHours} h). Press Reprocess to try again.` } },
    );
    if (res.modifiedCount) failed.push(String(s._id));
  }
  if (failed.length) deps.logger?.warn({ sessions: failed }, 'Stalled sessions marked failed');
  return failed;
}

// ---------------------------------------------------------------------------
// YouTube statistics (roadmap: analytics feedback loop)
// ---------------------------------------------------------------------------

/** Refresh views/likes/comments of Shorts published in the last 90 days (1 quota unit per 50 videos). */
export async function refreshVideoStats(
  deps: { account: YouTubeAccountService; logger?: Logger; fetchStats?: typeof fetchVideoStats },
  now = new Date(),
): Promise<{ updated: number; missing: number }> {
  if (deps.account.uploadsAreMock || !(await deps.account.isConnected())) return { updated: 0, missing: 0 };
  const due = await GeneratedClipModel.find({
    uploadStatus: UploadStatus.PUBLISHED,
    youtubeVideoId: { $ne: null, $not: /^mock/ },
    publishedAt: { $gte: new Date(now.getTime() - 90 * DAY) },
    $or: [{ stats: null }, { 'stats.fetchedAt': { $lt: new Date(now.getTime() - 5 * 3600_000) } }],
  })
    .select('youtubeVideoId')
    .limit(500)
    .lean();
  const fetchStats = deps.fetchStats ?? fetchVideoStats;
  let updated = 0;
  let missing = 0;
  for (let i = 0; i < due.length; i += 50) {
    const batch = due.slice(i, i + 50);
    const stats = await fetchStats(batch.map((c) => c.youtubeVideoId!), await deps.account.accessToken());
    const byId = new Map(stats.map((s) => [s.id, s]));
    for (const c of batch) {
      const s = byId.get(c.youtubeVideoId!);
      if (!s) {
        missing++;
        await GeneratedClipModel.updateOne({ _id: c._id }, { $set: { stats: { views: 0, likes: 0, comments: 0, privacyStatus: 'deleted', fetchedAt: now } } });
        continue;
      }
      await GeneratedClipModel.updateOne({ _id: c._id }, { $set: { stats: { views: s.views, likes: s.likes, comments: s.comments, privacyStatus: s.privacyStatus, fetchedAt: now } } });
      updated++;
    }
  }
  if (updated || missing) deps.logger?.info({ updated, missing }, 'YouTube stats refreshed');
  return { updated, missing };
}
