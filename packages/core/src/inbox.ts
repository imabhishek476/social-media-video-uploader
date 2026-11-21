import fsp from 'node:fs/promises';
import path from 'node:path';
import { LiveSessionModel, StreamerChannelModel, mongoose } from '@shorts/database';
import type { ObjectStorage, YouTubeMetadataProvider } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { ProcessingStatus, SessionStatus, type LiveSessionDTO } from '@shorts/shared-types';
import { DomainError } from './errors';
import { EndReason, type LiveSessionService } from './sessions';
import { INBOX_PREFIX, incomingDir, parseInboxName } from './source-provider';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Video id from anything a person might paste: watch, youtu.be, /live/,
 * /shorts/, /embed/ URLs (any YouTube host) or a bare 11-character id.
 */
export function parseVideoInput(raw: string): string | null {
  const s = raw.trim();
  if (VIDEO_ID_RE.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') ?? url.pathname.match(/^\/(?:live|shorts|embed|v)\/([^/?#]+)/)?.[1] ?? null;
  }
  return id && VIDEO_ID_RE.test(id) ? id : null;
}

/**
 * Register a broadcast the monitor missed (spec: "add a YouTube URL if a live
 * was missed"). Uses one `videos.list` call; the video must belong to a
 * registered streamer. Ended streams go straight to processing; a stream
 * that is still live is handed to the session watcher.
 */
export class SessionImportService {
  constructor(private readonly deps: { provider: YouTubeMetadataProvider; sessions: LiveSessionService; logger?: Logger }) {}

  async importVideo(input: string): Promise<{ session: LiveSessionDTO; created: boolean }> {
    const videoId = parseVideoInput(input);
    if (!videoId) throw new DomainError('INVALID_VIDEO_URL', 'That does not look like a YouTube video URL or id', 400);

    const existing = await LiveSessionModel.findOne({ broadcastId: videoId }).select('_id').lean();
    if (existing) return { session: await this.deps.sessions.get(String(existing._id)), created: false };

    const [video] = await this.deps.provider.getVideos([videoId]);
    if (!video) throw new DomainError('VIDEO_NOT_FOUND', 'Video not found. It may be private, deleted, or the id is wrong.', 404);
    if (video.liveBroadcastContent === 'upcoming') throw new DomainError('VIDEO_NOT_STARTED', 'This stream has not started yet; it is detected automatically once it goes live.', 409);

    const channel = await StreamerChannelModel.findOne({ channelId: video.channelId, deletedAt: null }).lean();
    if (!channel) {
      throw new DomainError('CHANNEL_NOT_REGISTERED', `This video belongs to channel ${video.channelId}, which is not a registered streamer. Add the channel on the Streamers page first.`, 409, {
        channelId: video.channelId,
      });
    }

    // Importing on purpose brings back a broadcast whose session was deleted earlier.
    await StreamerChannelModel.updateOne({ _id: channel._id }, { $pull: { ignoredBroadcastIds: video.videoId } });
    const { id, created } = await this.deps.sessions.recordLive(channel, video);
    if (video.liveBroadcastContent !== 'live') {
      await this.deps.sessions.endSession(id, video.actualEndTime ?? new Date(), EndReason.IMPORTED);
    }
    this.deps.logger?.info({ liveSessionId: id, videoId, live: video.liveBroadcastContent === 'live' }, 'Imported video as a session');
    return { session: await this.deps.sessions.get(id), created };
  }
}

export interface InboxPickupResult {
  files: number;
  reprocessed: string[];
  imported: string[];
  skipped: Array<{ file: string; reason: string }>;
}

/**
 * Inbox watcher: when a recording lands in the bucket's `incoming/` (or the
 * local incoming folder), start processing without anyone pressing
 * Reprocess. A file named after a YouTube video id with no session yet is
 * imported as a missed live first.
 */
export class InboxWatcher {
  /** Files that could not be matched; retried after a while instead of every tick. */
  private readonly unmatched = new Map<string, number>();

  constructor(
    private readonly deps: {
      storage: ObjectStorage;
      storageDir: string;
      sessions: LiveSessionService;
      importer: SessionImportService;
      logger?: Logger;
    },
  ) {}

  private async names(): Promise<string[]> {
    const remote = (await this.deps.storage.list(INBOX_PREFIX)).map((o) => path.basename(o.key));
    const local = await fsp.readdir(incomingDir(this.deps.storageDir)).catch(() => [] as string[]);
    return [...new Set([...remote, ...local])];
  }

  async tick(now = Date.now()): Promise<InboxPickupResult> {
    const result: InboxPickupResult = { files: 0, reprocessed: [], imported: [], skipped: [] };
    for (const file of await this.names()) {
      const parsed = parseInboxName(file);
      if (!parsed) continue;
      result.files++;
      const retryAt = this.unmatched.get(file);
      if (retryAt && retryAt > now) continue;

      const byId = mongoose.isValidObjectId(parsed.base) ? await LiveSessionModel.findById(parsed.base).select('status processingStatus').lean() : null;
      const session = byId ?? (await LiveSessionModel.findOne({ broadcastId: parsed.base }).select('status processingStatus').lean());

      try {
        if (!session) {
          if (!VIDEO_ID_RE.test(parsed.base)) throw new DomainError('UNMATCHED', 'name is neither a session id nor a YouTube video id', 400);
          const { session: s } = await this.deps.importer.importVideo(parsed.base);
          result.imported.push(s.id);
          continue;
        }
        const waiting = session.status === SessionStatus.SOURCE_UNAVAILABLE || (session.status === SessionStatus.ENDED && session.processingStatus === ProcessingStatus.NOT_STARTED);
        const busy = session.processingStatus === ProcessingStatus.QUEUED || session.processingStatus === ProcessingStatus.RUNNING;
        if (waiting && !busy) {
          await this.deps.sessions.reprocess(String(session._id));
          result.reprocessed.push(String(session._id));
        }
        // Otherwise acquisition is already queued/running and will find the file itself.
      } catch (err) {
        const reason = (err as Error).message;
        result.skipped.push({ file, reason });
        this.unmatched.set(file, now + 30 * 60_000);
        this.deps.logger?.warn({ file, reason }, 'Inbox recording not matched');
      }
    }
    if (result.reprocessed.length || result.imported.length) this.deps.logger?.info(result, 'Inbox recordings picked up');
    return result;
  }
}
