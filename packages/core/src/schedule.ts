import { GeneratedClipModel, LiveSessionModel, StreamerChannelModel, mongoose } from '@shorts/database';
import { YouTubePublishError, setVideoSchedule } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { UploadStatus, type ScheduleDTO } from '@shorts/shared-types';
import { DomainError } from './errors';
import { bestHours, parseSkipDays, parseSlotTimes, planSlot } from './scheduling';
import type { SettingsService } from './settings';

/** Shorts going public sooner than this are uploaded as public right away. */
export const IMMEDIATE_WITHIN_MS = 5 * 60_000;

const hhmm = ([h, m]: [number, number]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/**
 * Scheduled publishing (Phase 8): gives each approved Short a publish slot,
 * lists the calendar, and moves or releases slots (also on YouTube when the
 * Short is already uploaded as scheduled-private).
 */
export class ScheduleService {
  constructor(
    private readonly deps: {
      settings: SettingsService;
      /** Access token for the connected channel; only needed to change uploaded Shorts. */
      accessToken?: () => Promise<string>;
      logger?: Logger;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** Slot times in use: learned best hours (BEST_TIME with enough data) or the Settings list. */
  async slots(): Promise<{ slots: Array<[number, number]>; source: 'learned' | 'settings' }> {
    const { publishing } = (await this.deps.settings.getValues()).values;
    const configured = parseSlotTimes(publishing.slotTimes);
    if (publishing.timingMode === 'BEST_TIME') {
      const since = new Date(this.now().getTime() - 60 * 86_400_000);
      const rows = await GeneratedClipModel.find({ youtubeVideoId: { $ne: null }, publishedAt: { $gte: since, $lte: this.now() }, 'stats.views': { $ne: null } })
        .select('publishedAt stats.views')
        .lean();
      const learned = bestHours(
        rows.map((r) => ({ at: r.publishedAt!, views: r.stats?.views ?? 0 })),
        publishing.timezone,
        Math.max(1, configured.length),
      );
      if (learned) return { slots: learned, source: 'learned' };
    }
    return { slots: configured, source: 'settings' };
  }

  /**
   * Give the clip a publish slot (kept if it already has a future one).
   * Returns null in IMMEDIATE mode, when the default privacy isn't public (scheduled
   * Shorts always go public at their slot), or when no slot fits.
   */
  async assign(clipId: string): Promise<Date | null> {
    const { publishing } = (await this.deps.settings.getValues()).values;
    if (publishing.timingMode === 'IMMEDIATE' || publishing.privacyStatus !== 'public') return null;
    const clip = await GeneratedClipModel.findById(clipId).select('goLiveAt liveSessionId').lean();
    if (!clip) return null;
    const now = this.now();
    if (clip.goLiveAt && clip.goLiveAt > now) return clip.goLiveAt;
    const { slots } = await this.slots();
    const upcoming = await GeneratedClipModel.find({ _id: { $ne: clipId }, goLiveAt: { $gte: new Date(now.getTime() - 86_400_000) } })
      .select('goLiveAt liveSessionId')
      .lean();
    const at = planSlot({
      now,
      timeZone: publishing.timezone,
      slots,
      skipDays: parseSkipDays(publishing.skipDays),
      taken: upcoming.map((c) => c.goLiveAt!),
      sameSource: upcoming.filter((c) => String(c.liveSessionId) === String(clip.liveSessionId)).map((c) => c.goLiveAt!),
      maxPerSourcePerDay: publishing.maxPerSourcePerDay,
      dayGap: publishing.dayGap,
    });
    await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { goLiveAt: at } });
    return at;
  }

  async list(days = 14): Promise<ScheduleDTO> {
    const { publishing } = (await this.deps.settings.getValues()).values;
    const now = this.now();
    const { slots, source } = await this.slots();
    const clips = await GeneratedClipModel.find({
      goLiveAt: { $gte: new Date(now.getTime() - 86_400_000), $lte: new Date(now.getTime() + days * 86_400_000) },
      uploadStatus: { $ne: UploadStatus.NOT_UPLOADED },
    })
      .sort({ goLiveAt: 1 })
      .lean();
    const sessions = await LiveSessionModel.find({ _id: { $in: clips.map((c) => c.liveSessionId) } }).select('streamerChannelId').lean();
    const streamers = await StreamerChannelModel.find({ _id: { $in: sessions.map((s) => s.streamerChannelId) } }).select('displayName').lean();
    const nameOf = (sessionId: unknown) => {
      const s = sessions.find((x) => String(x._id) === String(sessionId));
      return streamers.find((x) => String(x._id) === String(s?.streamerChannelId))?.displayName ?? '';
    };
    return {
      timingMode: publishing.timingMode,
      privacyStatus: publishing.privacyStatus,
      timezone: publishing.timezone,
      slots: slots.map(hhmm),
      slotsSource: source,
      items: clips.map((c) => ({
        id: String(c._id),
        liveSessionId: String(c.liveSessionId),
        title: c.title,
        streamerName: nameOf(c.liveSessionId),
        goLiveAt: c.goLiveAt!.toISOString(),
        uploaded: Boolean(c.youtubeVideoId),
        youtubeUrl: c.youtubeUrl ?? null,
        uploadStatus: c.uploadStatus,
        lastError: c.lastError ?? null,
      })),
    };
  }

  /** Move a Short to another time (also on YouTube when already uploaded). */
  async reschedule(clipId: string, at: Date): Promise<void> {
    if (Number.isNaN(at.getTime())) throw new DomainError('VALIDATION_ERROR', 'Invalid date', 400);
    if (at.getTime() < this.now().getTime() + IMMEDIATE_WITHIN_MS) throw new DomainError('VALIDATION_ERROR', 'Pick a time at least 5 minutes from now, or use "Publish now"', 400);
    const clip = await this.load(clipId);
    if (clip.youtubeVideoId) {
      if (clip.publishedAt && clip.publishedAt <= this.now()) throw new DomainError('ALREADY_PUBLIC', 'This Short is already public on YouTube', 409);
      await this.updateOnYouTube(clip.youtubeVideoId, at);
      await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { goLiveAt: at, publishedAt: at } });
    } else {
      await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { goLiveAt: at } });
    }
  }

  /** Make a scheduled Short public now (or upload it as public as soon as it can). */
  async publishNow(clipId: string): Promise<void> {
    const clip = await this.load(clipId);
    const now = this.now();
    if (clip.youtubeVideoId) {
      if (clip.publishedAt && clip.publishedAt <= now) return;
      await this.updateOnYouTube(clip.youtubeVideoId, null);
    }
    await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { goLiveAt: now, ...(clip.youtubeVideoId ? { publishedAt: now } : {}) } });
  }

  private async updateOnYouTube(videoId: string, at: Date | null) {
    try {
      await setVideoSchedule(videoId, at, await this.token());
    } catch (err) {
      if (err instanceof YouTubePublishError && err.code === 'RECONNECT') {
        throw new DomainError(
          'YOUTUBE_PERMISSION_MISSING',
          'YouTube did not allow changing this video. Reconnect the channel in Settings → YouTube and allow managing your videos, then try again.',
          409,
        );
      }
      if (err instanceof YouTubePublishError) throw new DomainError('YOUTUBE_ERROR', err.message, 502);
      throw err;
    }
  }

  private async token() {
    if (!this.deps.accessToken) throw new DomainError('YOUTUBE_NOT_CONNECTED', 'Connect the YouTube channel in Settings first', 409);
    return this.deps.accessToken();
  }

  private async load(clipId: string) {
    if (!mongoose.isValidObjectId(clipId)) throw DomainError.notFound('Clip');
    const clip = await GeneratedClipModel.findById(clipId).lean();
    if (!clip) throw DomainError.notFound('Clip');
    if (clip.uploadStatus === UploadStatus.NOT_UPLOADED || clip.uploadStatus === UploadStatus.UPLOAD_FAILED) {
      throw new DomainError('NOT_SCHEDULED', 'Approve the Short first', 409);
    }
    return clip;
  }
}
