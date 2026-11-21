import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ChatActivityModel,
  GeneratedClipModel,
  HighlightCandidateModel,
  LiveSessionModel,
  ProcessingJobModel,
  StreamerChannelModel,
  TranscriptChunkModel,
  TranscriptModel,
  mongoose,
} from '@shorts/database';
import type { ObjectStorage } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import type { QueueRegistry } from '@shorts/queue';
import { ALL_QUEUE_NAMES } from '@shorts/shared-types';
import { DomainError } from './errors';

/** Stop a yt-dlp download still running for this session on this machine (best effort). */
function stopDownloads(sessionId: string) {
  if (!/^[a-f0-9]{24}$/.test(sessionId)) return;
  spawn('pkill', ['-f', `ytdlp-${sessionId}`], { stdio: 'ignore' }).on('error', () => undefined);
}

export interface PurgeSummary {
  sessions: number;
  clips: number;
  files: number;
  jobs: number;
}

/**
 * Permanently deletes a streamer and everything derived from it: sessions,
 * transcripts, highlights, clips, chat activity, job records, queued jobs,
 * stored recordings/Shorts (in every configured storage) and temp files.
 * Videos already published to YouTube/Instagram are not touched.
 */
export class StreamerPurgeService {
  constructor(
    private readonly deps: {
      /** Every storage that may hold files (current provider plus any previous one). */
      storages: ObjectStorage[];
      queues?: QueueRegistry;
      /** `<storageDir>/tmp`: downloads, partial transcripts, render scratch. */
      tempDir: string;
      logger?: Logger;
    },
  ) {}

  async purge(streamerId: string): Promise<PurgeSummary> {
    if (!mongoose.isValidObjectId(streamerId)) throw DomainError.notFound('Streamer');
    const streamer = await StreamerChannelModel.findById(streamerId).select('_id displayName').lean();
    if (!streamer) throw DomainError.notFound('Streamer');

    // Stop monitoring first so nothing new is created while we delete.
    await StreamerChannelModel.updateOne({ _id: streamerId }, { $set: { monitoringEnabled: false, deletedAt: new Date() } });

    const sessions = await LiveSessionModel.find({ streamerChannelId: streamerId }).select('_id').lean();
    const summary = await this.purgeSessions(sessions.map((s) => String(s._id)));
    await StreamerChannelModel.deleteOne({ _id: streamerId });
    this.deps.logger?.info({ streamerId, name: streamer.displayName, ...summary }, 'Streamer and all its data deleted');
    return summary;
  }

  /** Permanently delete one session (recording, transcript, highlights, Shorts, files). */
  async purgeSession(sessionId: string): Promise<PurgeSummary> {
    if (!mongoose.isValidObjectId(sessionId) || !(await LiveSessionModel.exists({ _id: sessionId }))) throw DomainError.notFound('Session');
    const s = await LiveSessionModel.findById(sessionId).select('streamerChannelId broadcastId').lean();
    // Remember the broadcast so the monitor doesn't re-create it (Add missed live still can).
    await StreamerChannelModel.updateOne({ _id: s!.streamerChannelId }, { $addToSet: { ignoredBroadcastIds: s!.broadcastId } });
    stopDownloads(sessionId);
    const summary = await this.purgeSessions([sessionId]);
    // Clear the channel's pointers to it.
    await StreamerChannelModel.updateOne({ _id: s!.streamerChannelId, currentLiveSessionId: sessionId }, { $set: { currentLiveSessionId: null, currentLiveTitle: null } });
    await StreamerChannelModel.updateOne({ _id: s!.streamerChannelId, lastLiveSessionId: sessionId }, { $set: { lastLiveSessionId: null } });
    this.deps.logger?.info({ sessionId, ...summary }, 'Session and all its data deleted');
    return summary;
  }

  private async purgeSessions(sessionIds: string[]): Promise<PurgeSummary> {
    const sessions = await LiveSessionModel.find({ _id: { $in: sessionIds } }).select('_id sourceMedia.storageKey').lean();
    const clips = await GeneratedClipModel.find({ liveSessionId: { $in: sessionIds } }).select('_id storageKey thumbnailKey subtitleKey').lean();
    const clipIds = clips.map((c) => String(c._id));
    const ids = new Set([...sessionIds, ...clipIds]);

    for (const id of sessionIds) stopDownloads(id);
    const jobs = await this.removeQueuedJobs(ids);
    const files = await this.deleteFiles(sessionIds, [
      ...sessions.map((s) => s.sourceMedia?.storageKey),
      ...clips.flatMap((c) => [c.storageKey, c.thumbnailKey, c.subtitleKey]),
    ]);

    const transcripts = await TranscriptModel.find({ liveSessionId: { $in: sessionIds } }).select('_id').lean();
    const entityIds = [...ids].map((id) => new mongoose.Types.ObjectId(id));
    await Promise.all([
      TranscriptChunkModel.deleteMany({ $or: [{ liveSessionId: { $in: sessionIds } }, { transcriptId: { $in: transcripts.map((t) => t._id) } }] }),
      TranscriptModel.deleteMany({ liveSessionId: { $in: sessionIds } }),
      HighlightCandidateModel.deleteMany({ liveSessionId: { $in: sessionIds } }),
      GeneratedClipModel.deleteMany({ _id: { $in: clipIds } }),
      ChatActivityModel.deleteMany({ liveSessionId: { $in: sessionIds } }),
      ProcessingJobModel.deleteMany({ entityId: { $in: entityIds } }),
    ]);
    await LiveSessionModel.deleteMany({ _id: { $in: sessionIds } });
    return { sessions: sessionIds.length, clips: clipIds.length, files, jobs };
  }

  /** Waiting/delayed/failed jobs for these sessions or clips (running ones see the data gone and skip). */
  private async removeQueuedJobs(ids: Set<string>): Promise<number> {
    if (!this.deps.queues || !ids.size) return 0;
    let n = 0;
    for (const name of ALL_QUEUE_NAMES) {
      const jobs = await this.deps.queues.get(name).getJobs(['waiting', 'delayed', 'prioritized', 'paused', 'failed', 'completed'], 0, 5000);
      for (const job of jobs) {
        const d = (job?.data ?? {}) as { liveSessionId?: string; clipId?: string };
        if ((d.liveSessionId && ids.has(String(d.liveSessionId))) || (d.clipId && ids.has(String(d.clipId)))) {
          await job.remove().then(() => n++, () => undefined);
        }
      }
    }
    return n;
  }

  private async deleteFiles(sessionIds: string[], keys: Array<string | null | undefined>): Promise<number> {
    let n = 0;
    const ok = () => n++;
    for (const storage of this.deps.storages) {
      for (const key of keys) if (key) await storage.delete(key).then(ok, () => undefined);
      for (const id of sessionIds) {
        for (const prefix of [`raw/${id}`, `clips/${id}`]) await storage.deletePrefix(prefix).catch(() => undefined);
      }
    }
    // Local scratch: yt-dlp downloads, partial transcripts, work dirs named after the session or clip.
    const entries = await fsp.readdir(this.deps.tempDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (sessionIds.some((id) => entry.includes(id))) {
        await fsp.rm(path.join(this.deps.tempDir, entry), { recursive: true, force: true }).then(ok, () => undefined);
      }
    }
    return n;
  }
}
