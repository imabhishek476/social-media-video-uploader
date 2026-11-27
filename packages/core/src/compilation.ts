import fsp from 'node:fs/promises';
import path from 'node:path';
import { CompilationModel, GeneratedClipModel, LiveSessionModel, StreamerChannelModel } from '@shorts/database';
import { videoUrlFor, type ObjectStorage, type YouTubeUploader } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { UploadStatus } from '@shorts/shared-types';
import { probeMedia } from './ffprobe';
import { focusLanguageMismatch, withChannelBranding, type YouTubeAccountService } from './publishing';
import { chapterStamp, renderCompilation } from './render';
import { localDay, localHour } from './scheduling';
import type { SettingsService } from './settings';

const DAY = 86_400_000;
/** Aim for a long video of about this length (more watch time per viewer). */
const TARGET_SECONDS = 10 * 60;
const MAX_CLIPS = 25;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface CompilationSummaryDTO {
  id: string;
  weekKey: string;
  status: string;
  title: string;
  clipCount: number;
  durationSeconds: number | null;
  youtubeUrl: string | null;
  lastError: string | null;
  createdAt: string;
}

const short = (d: Date, timeZone: string) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });

/**
 * Weekly "best of" long video (Phase 8.5): the week's most-watched public
 * Shorts joined into one 16:9 video with chapters and credits, uploaded to the
 * channel. Long videos earn more per view and count toward watch hours.
 */
export class CompilationService {
  constructor(
    private readonly deps: {
      settings: SettingsService;
      storage: ObjectStorage;
      account: YouTubeAccountService;
      uploader: YouTubeUploader;
      workDir: string;
      logger?: Logger;
    },
  ) {}

  /** Builds this week's compilation when it's the configured day and hour and it isn't done yet. */
  async runIfDue(now = new Date()): Promise<string> {
    const { publishing: p } = (await this.deps.settings.getValues()).values;
    if (p.weeklyCompilation === 'OFF') return 'off';
    const weekday = WEEKDAYS[new Date(`${localDay(now, p.timezone)}T12:00:00Z`).getUTCDay()];
    if (weekday !== p.compilationDay || localHour(now, p.timezone) < p.compilationHour) return 'not due';
    return this.build({ now });
  }

  /** Build (or retry) the compilation for the week ending today. `force` rebuilds a skipped/failed one. */
  async build(opts: { now?: Date; force?: boolean } = {}): Promise<string> {
    const now = opts.now ?? new Date();
    const { publishing: p } = (await this.deps.settings.getValues()).values;
    const weekKey = localDay(now, p.timezone);
    const existing = await CompilationModel.findOne({ weekKey }).lean();
    if (existing?.status === 'PUBLISHED') return 'already published';
    if (existing && !opts.force && ['SKIPPED', 'BUILDING', 'UPLOADING'].includes(existing.status!)) return existing.status!.toLowerCase();
    if (existing?.status === 'FAILED' && (existing.attempts ?? 0) >= 3 && !opts.force) return 'failed';
    if (!(await this.deps.account.isConnected())) return 'youtube not connected';

    const clips = await this.pickClips(now, p.focusLanguage);
    if (clips.length < p.compilationMinShorts) {
      await CompilationModel.updateOne(
        { weekKey },
        { $set: { status: 'SKIPPED', lastError: `Only ${clips.length} public Shorts this week (needs ${p.compilationMinShorts}).` } },
        { upsert: true },
      );
      return 'skipped';
    }
    await CompilationModel.updateOne({ weekKey }, { $set: { status: 'BUILDING', clipIds: clips.map((c) => c._id), lastError: null }, $inc: { attempts: 1 } }, { upsert: true });

    const work = path.join(this.deps.workDir, `compilation-${weekKey}`);
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
    try {
      // Download the Shorts and measure their real lengths for the chapters.
      const files: string[] = [];
      const lengths: number[] = [];
      for (const [i, c] of clips.entries()) {
        const f = path.join(work, `${String(i).padStart(2, '0')}.mp4`);
        await this.deps.storage.download(c.storageKey!, f);
        files.push(f);
        lengths.push((await probeMedia(f)).durationSeconds);
      }
      const total = lengths.reduce((a, b) => a + b, 0);
      const video = path.join(work, 'compilation.mp4');
      await renderCompilation(files, video, total);

      const { title, description, tags } = await this.metadata(clips, lengths, now, p);
      await CompilationModel.updateOne({ weekKey }, { $set: { status: 'UPLOADING', title, description, durationSeconds: Math.round(total) } });
      const resume = (await CompilationModel.findOne({ weekKey }).select('+resumableUploadUrl').lean())?.resumableUploadUrl ?? null;
      const token = () => this.deps.account.accessToken();
      const { videoId } = await this.deps.uploader.upload(
        {
          filePath: video,
          metadata: { title, description, tags, categoryId: p.categoryId || '20', privacyStatus: p.privacyStatus },
          resumeUrl: resume,
          onSession: async (url) => void (await CompilationModel.updateOne({ weekKey }, { $set: { resumableUploadUrl: url } })),
        },
        token,
      );
      const thumb = path.join(work, 'thumb.jpg');
      await this.frame(video, Math.min(5, total / 2), thumb)
        .then(() => this.deps.uploader.setThumbnail(videoId, thumb, token))
        .catch((err: Error) => this.deps.logger?.warn({ err: err.message }, 'Compilation thumbnail not set'));
      await CompilationModel.updateOne(
        { weekKey },
        { $set: { status: 'PUBLISHED', youtubeVideoId: videoId, youtubeUrl: videoUrlFor(videoId), publishedAt: new Date(), resumableUploadUrl: null } },
      );
      this.deps.logger?.info({ weekKey, videoId, clips: clips.length, seconds: Math.round(total) }, 'Weekly compilation published');
      return 'published';
    } catch (err) {
      await CompilationModel.updateOne({ weekKey }, { $set: { status: 'FAILED', lastError: (err as Error).message.slice(0, 500) } });
      throw err;
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async list(limit = 8): Promise<CompilationSummaryDTO[]> {
    const rows = await CompilationModel.find().sort({ createdAt: -1 }).limit(limit).lean();
    return rows.map((r) => ({
      id: String(r._id),
      weekKey: r.weekKey,
      status: r.status!,
      title: r.title ?? '',
      clipCount: r.clipIds?.length ?? 0,
      durationSeconds: r.durationSeconds ?? null,
      youtubeUrl: r.youtubeUrl ?? null,
      lastError: r.lastError ?? null,
      createdAt: (r as { createdAt?: Date }).createdAt?.toISOString() ?? '',
    }));
  }

  /** The week's public Shorts, most-watched first, up to about 10 minutes. */
  private async pickClips(now: Date, focusLanguage: string) {
    const all = await GeneratedClipModel.find({
      uploadStatus: UploadStatus.PUBLISHED,
      youtubeVideoId: { $ne: null },
      storageKey: { $ne: null },
      filesExpired: { $ne: true },
      publishedAt: { $gte: new Date(now.getTime() - 7 * DAY), $lte: now },
    }).lean();
    all.sort((a, b) => (b.stats?.views ?? 0) - (a.stats?.views ?? 0) || (b.highlightScore ?? 0) - (a.highlightScore ?? 0));
    const picked: typeof all = [];
    let seconds = 0;
    const mismatch = new Map<string, boolean>();
    for (const c of all) {
      const sid = String(c.liveSessionId);
      if (!mismatch.has(sid)) mismatch.set(sid, Boolean(await focusLanguageMismatch(sid, focusLanguage)));
      if (mismatch.get(sid)) continue;
      picked.push(c);
      seconds += c.durationSeconds ?? 30;
      if (seconds >= TARGET_SECONDS || picked.length >= MAX_CLIPS) break;
    }
    return picked;
  }

  private async metadata(clips: Awaited<ReturnType<CompilationService['pickClips']>>, lengths: number[], now: Date, p: { timezone: string; descriptionFooter: string; channelHashtags: string }) {
    const sessions = await LiveSessionModel.find({ _id: { $in: clips.map((c) => c.liveSessionId) } }).select('streamerChannelId broadcastId title').lean();
    const streamers = await StreamerChannelModel.find({ _id: { $in: sessions.map((s) => s.streamerChannelId) } }).select('displayName').lean();
    const names = [...new Set(streamers.map((s) => s.displayName))];
    const range = `${short(new Date(now.getTime() - 6 * DAY), p.timezone)}–${short(now, p.timezone)}`;
    const who = names.length <= 2 ? names.join(' & ') : 'Streamer';
    const title = `${who} Best Moments This Week (${range})`.slice(0, 100);
    let t = 0;
    const chapters = clips.map((c, i) => {
      const line = `${chapterStamp(t)} ${(c.title || `Moment ${i + 1}`).replace(/#\S+/g, '').trim()}`;
      t += lengths[i]!;
      return line;
    });
    const credits = sessions.map((s) => {
      const name = streamers.find((x) => String(x._id) === String(s.streamerChannelId))?.displayName ?? '';
      return `🎮 ${name}: ${videoUrlFor(s.broadcastId)}`;
    });
    const tags = [...new Set(clips.flatMap((c) => c.tags ?? []))].slice(0, 15);
    const body = [`The ${clips.length} best moments from this week's streams, all in one video.`, '', 'Chapters', ...chapters, '', 'Full streams', ...credits].join('\n');
    const description = withChannelBranding(`${body}\n#gaming #streamhighlights`, p.descriptionFooter, p.channelHashtags).slice(0, 4900);
    return { title, description, tags };
  }

  private async frame(video: string, at: number, out: string) {
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-v', 'error', '-y', '-ss', at.toFixed(2), '-i', video, '-frames:v', '1', '-q:v', '3', out]);
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    });
  }
}
