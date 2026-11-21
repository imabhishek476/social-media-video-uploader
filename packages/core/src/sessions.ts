import crypto from 'node:crypto';
import { LiveSessionModel, StreamerChannelModel, TranscriptChunkModel, TranscriptModel, mongoose } from '@shorts/database';
import { ProviderError, videoUrlFor, type VideoDetails, type YouTubeMetadataProvider } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { idempotencyKey, type QueueRegistry } from '@shorts/queue';
import {
  JobType,
  LiveStatus,
  ProcessingStatus,
  SessionStatus,
  type LiveSessionDTO,
  type Paginated,
  type SessionListQuery,
} from '@shorts/shared-types';
import { DomainError, isDuplicateKeyError } from './errors';
import { enqueueTracked } from './jobs';
import type { SettingsService } from './settings';

/** Sessions the watcher keeps polling. */
export const ACTIVE_SESSION_STATES = [SessionStatus.DETECTED, SessionStatus.LIVE] as const;
const REPROCESSABLE = [SessionStatus.ENDED, SessionStatus.SOURCE_READY, SessionStatus.PROCESSING, SessionStatus.HIGHLIGHTS_READY, SessionStatus.SOURCE_UNAVAILABLE, SessionStatus.FAILED, SessionStatus.COMPLETED, SessionStatus.CANCELLED];

export const EndReason = {
  PROVIDER_END_TIME: 'PROVIDER_END_TIME',
  NOT_LIVE_CONFIRMED: 'NOT_LIVE_CONFIRMED',
  UNAVAILABLE_CONFIRMED: 'UNAVAILABLE_CONFIRMED',
  MISSED_LIVE: 'MISSED_LIVE',
  /** Added by hand from a YouTube URL (or an inbox file named after the video id). */
  IMPORTED: 'IMPORTED',
} as const;
export type EndReason = (typeof EndReason)[keyof typeof EndReason];

export interface SessionDeps {
  queues: QueueRegistry;
  settings: SettingsService;
  provider: YouTubeMetadataProvider;
  /** Which object store holds sources (shown in the UI). */
  storageName?: 'local' | 'gcs';
  logger?: Logger;
}

export interface WatchSummary {
  checked: number;
  stillLive: number;
  ended: number;
  awaitingConfirmation: number;
  providerError: string | null;
}

type ChannelLike = { _id: mongoose.Types.ObjectId | string };

const iso = (d?: Date | null) => (d ? d.toISOString() : null);

export class LiveSessionService {
  constructor(private readonly deps: SessionDeps) {}

  /**
   * Record an observed live broadcast. Idempotent per (channel, broadcast)
   * thanks to the unique index — a broadcast seen many times yields exactly
   * one session (spec §6 Workflow B, MVP criterion 4).
   */
  async recordLive(channel: ChannelLike, video: VideoDetails, now = new Date()): Promise<{ id: string; created: boolean }> {
    const { monitoring } = (await this.deps.settings.getValues()).values;
    const filter = { streamerChannelId: channel._id, broadcastId: video.videoId };
    try {
      const res = await LiveSessionModel.findOneAndUpdate(
        filter,
        {
          $setOnInsert: {
            ...filter,
            status: SessionStatus.LIVE,
            title: video.title,
            startedAt: video.actualStartTime ?? now,
            lastObservedLiveAt: now,
            nextWatchAt: new Date(now.getTime() + monitoring.sessionWatchIntervalSeconds * 1000),
          },
        },
        { upsert: true, new: true, includeResultMetadata: true },
      );
      const created = !res.lastErrorObject?.updatedExisting;
      const id = String(res.value!._id);
      if (created) {
        await StreamerChannelModel.updateOne({ _id: channel._id }, { $inc: { totalSessions: 1 } });
        this.deps.logger?.info({ liveSessionId: id, broadcastId: video.videoId }, 'Live session created');
      }
      return { id, created };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const existing = await LiveSessionModel.findOne(filter).select('_id').lean();
      return { id: String(existing!._id), created: false };
    }
  }

  /**
   * A broadcast that started and ended between two monitor checks. Create
   * the session (if new) and end it immediately so it still gets processed.
   */
  async recordMissed(channel: ChannelLike, video: VideoDetails, now = new Date()): Promise<{ id: string; created: boolean }> {
    const result = await this.recordLive(channel, video, now);
    await this.endSession(result.id, video.actualEndTime ?? now, result.created ? EndReason.MISSED_LIVE : EndReason.PROVIDER_END_TIME);
    return result;
  }

  /**
   * Transition an active session to ENDED and enqueue post-live processing
   * exactly once. The status condition makes this atomic: concurrent callers
   * (watcher + monitor) can't both win.
   */
  async endSession(sessionId: string, endedAt: Date, reason: EndReason): Promise<boolean> {
    const current = await LiveSessionModel.findById(sessionId).select('startedAt status').lean();
    if (!current || !(ACTIVE_SESSION_STATES as readonly string[]).includes(current.status)) return false;
    const durationSeconds = current.startedAt ? Math.max(0, Math.round((endedAt.getTime() - current.startedAt.getTime()) / 1000)) : null;

    const session = await LiveSessionModel.findOneAndUpdate(
      { _id: sessionId, status: { $in: ACTIVE_SESSION_STATES } },
      {
        $set: {
          status: SessionStatus.ENDED,
          endedAt,
          endReason: reason,
          durationSeconds,
          processingStatus: ProcessingStatus.QUEUED,
          watchLeaseId: null,
          lastError: null,
        },
      },
      { new: true },
    ).lean();
    if (!session) return false;

    await StreamerChannelModel.updateOne(
      { _id: session.streamerChannelId, currentLiveSessionId: session._id },
      { $set: { liveStatus: LiveStatus.OFFLINE, currentLiveSessionId: null, currentLiveTitle: null } },
    );
    await StreamerChannelModel.updateOne(
      { _id: session.streamerChannelId },
      { $set: { lastLiveSessionId: session._id, lastLiveAt: endedAt } },
    );
    this.deps.logger?.info({ liveSessionId: sessionId, reason, durationSeconds }, 'Live session ended');
    await this.enqueueProcessing(sessionId, session.reprocessCount ?? 0);
    return true;
  }

  /**
   * Re-check active sessions and detect completion (spec §6 Workflow C).
   *  - provider `actualEndTime` → authoritative end
   *  - still `live` → reset confirmations
   *  - not live / unavailable → count; end after N consecutive observations
   *  - provider/API failure → change nothing (never treated as "ended")
   */
  async watchTick(now = new Date()): Promise<WatchSummary> {
    const { monitoring } = (await this.deps.settings.getValues()).values;
    const summary: WatchSummary = { checked: 0, stillLive: 0, ended: 0, awaitingConfirmation: 0, providerError: null };
    const leaseId = crypto.randomUUID();
    const nextWatchAt = new Date(now.getTime() + monitoring.sessionWatchIntervalSeconds * 1000);

    await LiveSessionModel.updateMany(
      { status: { $in: ACTIVE_SESSION_STATES }, nextWatchAt: { $lte: now } },
      { $set: { watchLeaseId: leaseId, nextWatchAt } },
    );
    const sessions = await LiveSessionModel.find({ watchLeaseId: leaseId }).lean();
    if (sessions.length === 0) return summary;

    let videos: Map<string, VideoDetails>;
    try {
      videos = new Map((await this.deps.provider.getVideos(sessions.map((s) => s.broadcastId))).map((v) => [v.videoId, v]));
    } catch (err) {
      const message = err instanceof ProviderError ? `[${err.code}] ${err.message}` : (err as Error).message;
      summary.providerError = message;
      this.deps.logger?.warn({ err: message, sessions: sessions.length }, 'Session watch: provider unavailable; sessions left unchanged');
      await LiveSessionModel.updateMany({ watchLeaseId: leaseId }, { $set: { watchLeaseId: null, lastError: `Watch check failed: ${message}` } });
      return summary;
    }

    for (const s of sessions) {
      summary.checked++;
      const id = String(s._id);
      const v = videos.get(s.broadcastId);

      if (v?.actualEndTime) {
        if (await this.endSession(id, v.actualEndTime, EndReason.PROVIDER_END_TIME)) summary.ended++;
        continue;
      }
      if (v?.liveBroadcastContent === 'live') {
        summary.stillLive++;
        await LiveSessionModel.updateOne(
          { _id: s._id },
          { $set: { status: SessionStatus.LIVE, title: v.title, lastObservedLiveAt: now, endConfirmationCount: 0, watchLeaseId: null, lastError: null } },
        );
        await StreamerChannelModel.updateOne(
          { _id: s.streamerChannelId },
          { $set: { liveStatus: LiveStatus.LIVE, currentLiveSessionId: s._id, currentLiveTitle: v.title } },
        );
        continue;
      }

      const count = (s.endConfirmationCount ?? 0) + 1;
      if (count >= monitoring.endConfirmationChecks) {
        const reason = v ? EndReason.NOT_LIVE_CONFIRMED : EndReason.UNAVAILABLE_CONFIRMED;
        await LiveSessionModel.updateOne({ _id: s._id }, { $set: { endConfirmationCount: count } });
        if (await this.endSession(id, s.lastObservedLiveAt ?? now, reason)) summary.ended++;
      } else {
        summary.awaitingConfirmation++;
        await LiveSessionModel.updateOne({ _id: s._id }, { $set: { endConfirmationCount: count, watchLeaseId: null } });
      }
    }
    return summary;
  }

  /** POST /live-sessions/:id/reprocess — safe, explicit re-run (spec §12). */
  /** `retranscribe` drops the stored transcript first (e.g. to get word-level timing). */
  async reprocess(sessionId: string, opts: { retranscribe?: boolean } = {}): Promise<LiveSessionDTO> {
    if (!mongoose.isValidObjectId(sessionId)) throw DomainError.notFound('Live session');
    const session = await LiveSessionModel.findOneAndUpdate(
      {
        _id: sessionId,
        status: { $in: REPROCESSABLE },
        processingStatus: { $nin: [ProcessingStatus.QUEUED, ProcessingStatus.RUNNING] },
      },
      { $inc: { reprocessCount: 1 }, $set: { status: SessionStatus.ENDED, processingStatus: ProcessingStatus.QUEUED, lastError: null } },
      { new: true },
    ).lean();
    if (!session) {
      const existing = await LiveSessionModel.findById(sessionId).select('status processingStatus').lean();
      if (!existing) throw DomainError.notFound('Live session');
      if ((ACTIVE_SESSION_STATES as readonly string[]).includes(existing.status)) {
        throw new DomainError('SESSION_STILL_LIVE', 'The stream is still live; it is processed automatically after it ends', 409);
      }
      throw new DomainError('ALREADY_QUEUED', 'Processing is already queued or running for this session', 409);
    }
    if (opts.retranscribe) {
      const t = await TranscriptModel.findOne({ liveSessionId: sessionId }).select('_id').lean();
      if (t) await Promise.all([TranscriptChunkModel.deleteMany({ transcriptId: t._id }), TranscriptModel.deleteOne({ _id: t._id })]);
    }
    await this.enqueueProcessing(sessionId, session.reprocessCount);
    return this.get(sessionId);
  }

  async list(q: SessionListQuery): Promise<Paginated<LiveSessionDTO>> {
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.streamerId) filter.streamerChannelId = q.streamerId;
    const [items, total] = await Promise.all([
      LiveSessionModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .populate('streamerChannelId', 'displayName channelId thumbnailUrl')
        .lean(),
      LiveSessionModel.countDocuments(filter),
    ]);
    return { items: items.map((i) => toSessionDTO(i, this.deps.storageName)), page: q.page, pageSize: q.pageSize, total };
  }

  async get(id: string): Promise<LiveSessionDTO> {
    if (!mongoose.isValidObjectId(id)) throw DomainError.notFound('Live session');
    const s = await LiveSessionModel.findById(id).populate('streamerChannelId', 'displayName channelId thumbnailUrl').lean();
    if (!s) throw DomainError.notFound('Live session');
    return toSessionDTO(s, this.deps.storageName);
  }

  /** Hand off to Phase 3 (media acquisition). Exactly once per (session, reprocess round). */
  private async enqueueProcessing(sessionId: string, round: number): Promise<void> {
    try {
      await enqueueTracked(this.deps.queues, {
        jobType: JobType.MEDIA_ACQUISITION,
        jobName: 'acquire-source',
        key: idempotencyKey('session', sessionId, 'acquire', round),
        entityType: 'LiveSession',
        entityId: sessionId,
        data: { liveSessionId: sessionId },
      });
    } catch (err) {
      this.deps.logger?.error({ err, liveSessionId: sessionId }, 'Failed to enqueue processing');
      await LiveSessionModel.updateOne(
        { _id: sessionId },
        { $set: { processingStatus: ProcessingStatus.NOT_STARTED, lastError: `Could not enqueue processing: ${(err as Error).message}. Use Reprocess to retry.` } },
      );
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toSessionDTO(s: any, storedIn?: 'local' | 'gcs'): LiveSessionDTO {
  const ch = s.streamerChannelId && typeof s.streamerChannelId === 'object' && 'displayName' in s.streamerChannelId ? s.streamerChannelId : null;
  return {
    id: String(s._id),
    streamer: {
      id: String(ch?._id ?? s.streamerChannelId),
      displayName: ch?.displayName ?? 'Unknown',
      channelId: ch?.channelId ?? '',
      thumbnailUrl: ch?.thumbnailUrl ?? null,
    },
    broadcastId: s.broadcastId,
    videoUrl: videoUrlFor(s.broadcastId),
    title: s.title ?? '',
    status: s.status,
    startedAt: iso(s.startedAt),
    endedAt: iso(s.endedAt),
    durationSeconds: s.durationSeconds ?? null,
    lastObservedLiveAt: iso(s.lastObservedLiveAt),
    endConfirmationCount: s.endConfirmationCount ?? 0,
    endReason: s.endReason ?? null,
    sourceMedia: {
      provider: s.sourceMedia?.provider ?? null,
      status: s.sourceMedia?.status ?? 'PENDING',
      lastError: s.sourceMedia?.lastError ?? null,
      durationSeconds: s.sourceMedia?.durationSeconds ?? null,
      fileSizeBytes: s.sourceMedia?.fileSizeBytes ?? null,
      width: s.sourceMedia?.width ?? null,
      height: s.sourceMedia?.height ?? null,
      videoCodec: s.sourceMedia?.videoCodec ?? null,
      progress:
        s.sourceMedia?.status === 'DOWNLOADING' && s.sourceMedia?.progress
          ? { ...s.sourceMedia.progress, updatedAt: new Date(s.sourceMedia.progress.updatedAt ?? Date.now()).toISOString() }
          : null,
      storedIn: s.sourceMedia?.storageKey ? (storedIn ?? null) : null,
    },
    processingStatus: s.processingStatus,
    processingStage: s.processingStage ?? null,
    highlightCount: s.highlightCount ?? 0,
    facecam: s.facecam?.source ? { x: s.facecam.x ?? 0, y: s.facecam.y ?? 0, w: s.facecam.w ?? 0, h: s.facecam.h ?? 0, source: s.facecam.source } : null,
    clipCount: s.clipCount ?? 0,
    estimatedCostUsd: Math.round((s.estimatedCostUsd ?? 0) * 10000) / 10000,
    reprocessCount: s.reprocessCount ?? 0,
    lastError: s.lastError ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
