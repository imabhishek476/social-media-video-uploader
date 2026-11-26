import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { decryptSecret, encryptSecret } from '@shorts/config';
import { GeneratedClipModel, HighlightCandidateModel, IntegrationCredentialModel, LiveSessionModel, StreamerChannelModel, TranscriptModel, mongoose } from '@shorts/database';
import {
  AiProviderError,
  YouTubePublishError,
  detectGame,
  videoUrlFor,
  youtubeShortUrl,
  type MetadataGenerator,
  type ObjectStorage,
  type YouTubeOAuthClient,
  type YouTubeUploader,
} from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { UnrecoverableError, idempotencyKey, type QueueRegistry, type Redis } from '@shorts/queue';
import { ApprovalStatus, JobType, PublishingMode, RenderStatus, UploadStatus, type ClipMetadataInput } from '@shorts/shared-types';
import { DomainError } from './errors';
import { nextWindowOpen } from './scheduling';
import { enqueueTracked } from './jobs';
import type { SettingsService } from './settings';
import { IMMEDIATE_WITHIN_MS, type ScheduleService } from './schedule';

const PROVIDER = 'youtube';
const STATE_TTL_SECONDS = 10 * 60;

// ---------------------------------------------------------------------------
// Central channel connection (spec §6 Workflow H)
// ---------------------------------------------------------------------------

/**
 * Owns the OAuth connection to the one destination channel. The refresh
 * token is stored AES-256-GCM encrypted; access tokens live only in memory.
 */
export class YouTubeAccountService {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly deps: { oauth: YouTubeOAuthClient | null; redis: Redis; encryptionKey?: string; logger?: Logger },
  ) {}

  private oauth(): YouTubeOAuthClient {
    if (!this.deps.oauth || !this.deps.encryptionKey) {
      throw new DomainError('YOUTUBE_NOT_CONFIGURED', 'YouTube OAuth is not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and ENCRYPTION_KEY.', 400);
    }
    return this.deps.oauth;
  }

  /** Start the consent flow; the random `state` ties the callback to this admin. */
  async startConnect(userId: string): Promise<string> {
    const oauth = this.oauth();
    const state = crypto.randomBytes(24).toString('hex');
    await this.deps.redis.set(`yt-oauth-state:${state}`, userId, 'EX', STATE_TTL_SECONDS);
    return oauth.authUrl(state);
  }

  async completeConnect(state: string, code: string): Promise<{ channelId: string; channelTitle: string }> {
    const oauth = this.oauth();
    const userId = await this.deps.redis.getdel(`yt-oauth-state:${state}`);
    if (!userId) throw new DomainError('OAUTH_STATE_INVALID', 'The connection link expired or was already used. Start again from Settings.', 400);
    const tokens = await oauth.exchangeCode(code);
    if (!tokens.refreshToken) throw new DomainError('OAUTH_NO_REFRESH_TOKEN', 'Google did not return a refresh token. Remove the app from your Google account permissions and connect again.', 400);
    const missing = ['youtube.upload'].filter((s) => !tokens.scope.includes(s));
    if (missing.length) throw new DomainError('OAUTH_SCOPE_MISSING', 'Upload permission was not granted. Connect again and allow managing your YouTube videos.', 400);
    const channel = await oauth.channel(tokens.accessToken);
    await IntegrationCredentialModel.findOneAndUpdate(
      { provider: PROVIDER },
      {
        $set: {
          accountId: channel.id,
          accountTitle: channel.title,
          scopes: tokens.scope.split(' ').filter(Boolean),
          encryptedRefreshToken: encryptSecret(tokens.refreshToken, this.deps.encryptionKey!),
          status: 'ACTIVE',
          lastError: null,
          connectedBy: mongoose.isValidObjectId(userId) ? userId : null,
          connectedAt: new Date(),
        },
      },
      { upsert: true },
    );
    this.cached = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    this.deps.logger?.info({ channelId: channel.id }, 'YouTube channel connected');
    return { channelId: channel.id, channelTitle: channel.title };
  }

  async disconnect(): Promise<void> {
    const cred = await IntegrationCredentialModel.findOne({ provider: PROVIDER }).select('+encryptedRefreshToken').lean();
    if (cred && this.deps.oauth && this.deps.encryptionKey) {
      await this.deps.oauth.revoke(decryptSecret(cred.encryptedRefreshToken, this.deps.encryptionKey)).catch(() => undefined);
    }
    await IntegrationCredentialModel.deleteOne({ provider: PROVIDER });
    this.cached = null;
  }

  async isConnected(): Promise<boolean> {
    return Boolean(await IntegrationCredentialModel.exists({ provider: PROVIDER, status: 'ACTIVE' }));
  }

  /** A valid access token, refreshed when needed. */
  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token;
    const oauth = this.oauth();
    const cred = await IntegrationCredentialModel.findOne({ provider: PROVIDER }).select('+encryptedRefreshToken').lean();
    if (!cred || cred.status !== 'ACTIVE') throw new YouTubePublishError('RECONNECT', 'No YouTube channel is connected. Connect it in Settings.', false);
    try {
      const t = await oauth.refresh(decryptSecret(cred.encryptedRefreshToken, this.deps.encryptionKey!));
      this.cached = { token: t.accessToken, expiresAt: t.expiresAt };
      return t.accessToken;
    } catch (err) {
      if (err instanceof YouTubePublishError && err.code === 'RECONNECT') {
        await IntegrationCredentialModel.updateOne({ provider: PROVIDER }, { $set: { status: 'ERROR', lastError: err.message } });
      }
      throw err;
    }
  }

  invalidate() {
    this.cached = null;
  }
}

// ---------------------------------------------------------------------------
// Metadata (spec §6 Workflow G)
// ---------------------------------------------------------------------------

const LANGUAGE_CODES: Record<string, string> = { english: 'en', hindi: 'hi', spanish: 'es', portuguese: 'pt', french: 'fr', german: 'de', japanese: 'ja', korean: 'ko', russian: 'ru', italian: 'it', arabic: 'ar', turkish: 'tr', indonesian: 'id' };
/**
 * Insert the channel footer above the hashtag line and merge the channel's
 * hashtags into it (#Shorts first; YouTube ignores all hashtags past 15).
 */
export function withChannelBranding(description: string, footer: string, channelHashtags: string): string {
  const lines = description.split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  const hasTagLine = last.startsWith('#');
  const body = (hasTagLine ? lines.slice(0, -1) : lines).join('\n').trimEnd();
  const existing = hasTagLine ? last.split(/\s+/).filter((t) => t.startsWith('#')) : [];
  const extra = channelHashtags
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
    .map((t) => `#${t}`);
  const seen = new Set<string>();
  const tags = [...existing, ...extra].filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 10);
  const foot = footer.replace(/\\n/g, '\n').trim();
  return [body, ...(foot ? ['', foot] : []), ...(tags.length ? ['', tags.join(' ')] : [])].join('\n').slice(0, 5000);
}

export const languageCode = (lang: string | null | undefined): string | undefined => {
  const l = (lang ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(l) ? l : LANGUAGE_CODES[l];
};

export function validateMetadata(m: ClipMetadataInput) {
  const problems: string[] = [];
  if (m.title !== undefined && (!m.title.trim() || m.title.length > 100)) problems.push('Title must be 1–100 characters');
  if (m.description !== undefined && m.description.length > 5000) problems.push('Description must be at most 5000 characters');
  if ([m.title, m.description].some((s) => s && /[<>]/.test(s))) problems.push('YouTube does not allow < or > in titles and descriptions');
  if (m.tags && m.tags.join(',').length > 500) problems.push('Tags must be at most 500 characters in total');
  if (problems.length) throw new DomainError('VALIDATION_FAILED', problems.join('; '), 400);
}

export class PublishService {
  constructor(
    private readonly deps: {
      settings: SettingsService;
      queues: QueueRegistry;
      account: YouTubeAccountService;
      metadata: MetadataGenerator;
      logger?: Logger;
      /** Runs after a clip is approved (e.g. queue the Instagram cross-post). Must not throw. */
      afterApprove?: (clipId: string) => Promise<unknown>;
      /** Scheduled publishing: gives approved clips a publish slot. */
      schedule?: ScheduleService;
    },
  ) {}

  /** Write metadata for one clip with the configured LLM. */
  async generateMetadata(clipId: string): Promise<void> {
    const clip = await GeneratedClipModel.findById(clipId).lean();
    if (!clip) throw DomainError.notFound('Clip');
    const [candidate, session, transcript] = await Promise.all([
      HighlightCandidateModel.findById(clip.highlightCandidateId).lean(),
      LiveSessionModel.findById(clip.liveSessionId).lean(),
      TranscriptModel.findOne({ liveSessionId: clip.liveSessionId }).select('language').lean(),
    ]);
    const streamer = session ? await StreamerChannelModel.findById(session.streamerChannelId).select('displayName preferences.game').lean() : null;
    const game = detectGame(streamer?.preferences?.game, session?.title);
    const out = await this.deps.metadata.generate({
      streamerName: streamer?.displayName ?? 'the streamer',
      streamTitle: session?.title ?? '',
      sourceUrl: session ? videoUrlFor(session.broadcastId) : '',
      hook: candidate?.hook ?? '',
      reason: candidate?.reason ?? '',
      topic: candidate?.topic ?? null,
      transcriptExcerpt: candidate?.transcriptExcerpt ?? '',
      durationSeconds: clip.durationSeconds,
      language: transcript?.language ?? 'en',
      game,
    });
    const { publishing } = (await this.deps.settings.getValues()).values;
    const description = withChannelBranding(out.description, publishing.descriptionFooter ?? '', publishing.channelHashtags ?? '');
    await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { title: out.title, description, tags: out.tags, metadataEditedByUser: false } });
    if (out.costUsd) await LiveSessionModel.updateOne({ _id: clip.liveSessionId }, { $inc: { estimatedCostUsd: out.costUsd } });
  }

  /**
   * After rendering: write metadata for clips that have none, then — in
   * AUTO_PUBLISH mode — approve and queue them for upload.
   */
  async prepareSession(sessionId: string): Promise<{ generated: number; autoApproved: number; failed: number }> {
    const clips = await GeneratedClipModel.find({ liveSessionId: sessionId, renderStatus: RenderStatus.RENDERED }).lean();
    let generated = 0;
    let failed = 0;
    for (const c of clips) {
      if (c.title || c.metadataEditedByUser) continue;
      try {
        await this.generateMetadata(String(c._id));
        generated++;
      } catch (err) {
        if (err instanceof AiProviderError && err.retryable) throw err; // let the queue retry the whole step
        failed++;
        await GeneratedClipModel.updateOne({ _id: c._id }, { $set: { lastError: `Metadata generation failed: ${(err as Error).message}`.slice(0, 500) } });
      }
    }
    let autoApproved = 0;
    const { publishing } = (await this.deps.settings.getValues()).values;
    if (publishing.mode === PublishingMode.AUTO_PUBLISH) {
      const pending = await GeneratedClipModel.find({ liveSessionId: sessionId, renderStatus: RenderStatus.RENDERED, approvalStatus: ApprovalStatus.PENDING, title: { $ne: '' } }).lean();
      for (const c of pending) {
        try {
          await this.approve(String(c._id), null);
          autoApproved++;
        } catch (err) {
          this.deps.logger?.warn({ err: (err as Error).message, clipId: String(c._id) }, 'Auto-approve skipped');
        }
      }
    }
    return { generated, autoApproved, failed };
  }

  async updateMetadata(clipId: string, input: ClipMetadataInput) {
    validateMetadata(input);
    const clip = await this.load(clipId);
    if ([UploadStatus.UPLOADING, UploadStatus.PUBLISHED].includes(clip.uploadStatus as never)) {
      throw new DomainError('CLIP_LOCKED', 'Metadata cannot change once the upload has started', 409);
    }
    const set: Record<string, unknown> = { metadataEditedByUser: true };
    if (input.title !== undefined) set.title = input.title.trim();
    if (input.description !== undefined) set.description = input.description;
    if (input.tags !== undefined) set.tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))];
    await GeneratedClipModel.updateOne({ _id: clipId }, { $set: set });
  }

  /** Approve a rendered clip and queue its upload (also used to retry a failed upload). `userId` null = automatic. */
  async approve(clipId: string, userId: string | null): Promise<void> {
    const clip = await this.load(clipId);
    if (clip.renderStatus !== RenderStatus.RENDERED) throw new DomainError('CLIP_NOT_RENDERED', 'Render the clip before approving it', 409);
    if (!clip.title.trim()) throw new DomainError('METADATA_MISSING', 'Add a title before approving', 409);
    if (![UploadStatus.NOT_UPLOADED, UploadStatus.UPLOAD_FAILED].includes(clip.uploadStatus as never)) {
      throw new DomainError('ALREADY_QUEUED', 'This clip is already queued, uploading or published', 409);
    }
    if (!(await this.deps.account.isConnected())) {
      throw new DomainError('YOUTUBE_NOT_CONNECTED', 'Connect the central YouTube channel in Settings first', 409);
    }
    const key = clip.uploadIdempotencyKey ?? `clip:${clipId}`;
    const attempt = (clip.uploadAttempts ?? 0) + 1;
    const res = await GeneratedClipModel.updateOne(
      { _id: clipId, uploadStatus: { $in: [UploadStatus.NOT_UPLOADED, UploadStatus.UPLOAD_FAILED] } },
      {
        $set: {
          approvalStatus: userId ? ApprovalStatus.APPROVED : ApprovalStatus.AUTO_APPROVED,
          approvedBy: userId,
          approvedAt: new Date(),
          uploadStatus: UploadStatus.QUEUED,
          uploadIdempotencyKey: key,
          uploadAttempts: attempt,
          lastError: null,
        },
      },
    );
    if (!res.modifiedCount) throw new DomainError('ALREADY_QUEUED', 'This clip is already queued, uploading or published', 409);
    // Pick the publish slot now so the calendar shows it straight away (the upload starts early).
    await this.deps.schedule?.assign(clipId).catch((err: Error) => this.deps.logger?.warn({ clipId, err: err.message }, 'No publish slot assigned'));
    await enqueueTracked(this.deps.queues, {
      jobType: JobType.YOUTUBE_UPLOAD,
      jobName: 'upload-short',
      key: idempotencyKey('clip', clipId, 'upload', attempt),
      entityType: 'GeneratedClip',
      entityId: clipId,
      data: { clipId },
    });
    await this.deps.afterApprove?.(clipId);
  }

  async reject(clipId: string, userId: string) {
    const clip = await this.load(clipId);
    if (clip.uploadStatus !== UploadStatus.NOT_UPLOADED && clip.uploadStatus !== UploadStatus.UPLOAD_FAILED) {
      throw new DomainError('CLIP_LOCKED', 'This clip is already queued, uploading or published', 409);
    }
    await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { approvalStatus: ApprovalStatus.REJECTED, approvedBy: userId, approvedAt: new Date() } });
  }

  private async load(clipId: string) {
    if (!mongoose.isValidObjectId(clipId)) throw DomainError.notFound('Clip');
    const clip = await GeneratedClipModel.findById(clipId).lean();
    if (!clip) throw DomainError.notFound('Clip');
    return clip;
  }
}

export async function enqueueMetadata(queues: QueueRegistry, sessionId: string, reason: string) {
  return enqueueTracked(queues, {
    jobType: JobType.METADATA_GENERATION,
    jobName: 'write-metadata',
    key: idempotencyKey('session', sessionId, 'metadata', reason),
    entityType: 'LiveSession',
    entityId: sessionId,
    data: { liveSessionId: sessionId },
  });
}

// ---------------------------------------------------------------------------
// Upload worker step
// ---------------------------------------------------------------------------

export type UploadOutcome = { videoId: string; url: string } | 'SKIPPED';

/**
 * Upload one approved clip (spec §6 Workflow H). Never uploads twice:
 * an existing video id short-circuits, and a stored resumable session is
 * resumed (or its finished video recovered) before a new one is started.
 * Respects the daily upload limit and minimum gap via `defer`.
 */
export class UploadService {
  constructor(
    private readonly deps: {
      settings: SettingsService;
      storage: ObjectStorage;
      account: YouTubeAccountService;
      uploader: YouTubeUploader;
      workDir: string;
      logger?: Logger;
      schedule?: ScheduleService;
    },
  ) {}

  /** When the next upload may start, or null if now. */
  async nextSlot(now = new Date()): Promise<Date | null> {
    const { publishing } = (await this.deps.settings.getValues()).values;
    let at = now;
    const later = (d: Date) => {
      if (d > at) at = d;
    };
    const dayAgo = new Date(now.getTime() - 86_400_000);
    if (publishing.dailyUploadLimit > 0) {
      const recent = await GeneratedClipModel.find({ publishedAt: { $gt: dayAgo } }).sort({ publishedAt: 1 }).select('publishedAt').lean();
      if (recent.length >= publishing.dailyUploadLimit) {
        later(new Date(recent[recent.length - publishing.dailyUploadLimit]!.publishedAt!.getTime() + 86_400_000 + 1000));
      }
    }
    if (publishing.minMinutesBetweenUploads > 0) {
      const last = await GeneratedClipModel.findOne({ publishedAt: { $ne: null } }).sort({ publishedAt: -1 }).select('publishedAt').lean();
      if (last?.publishedAt) later(new Date(last.publishedAt.getTime() + publishing.minMinutesBetweenUploads * 60_000));
    }
    // Then push into the publish window (e.g. 17:00–23:00 local time).
    const open = nextWindowOpen(at, publishing.windowStartHour, publishing.windowEndHour, publishing.timezone);
    if (open) later(open);
    return at > now ? at : null;
  }

  async upload(clipId: string, ctx: { defer: (until: Date, reason: string) => Promise<never>; onProgress?: (pct: number) => Promise<void> }): Promise<UploadOutcome> {
    const clip = await GeneratedClipModel.findById(clipId).select('+resumableUploadUrl').lean();
    if (!clip) return 'SKIPPED';
    if (clip.youtubeVideoId) return { videoId: clip.youtubeVideoId, url: clip.youtubeUrl ?? youtubeShortUrl(clip.youtubeVideoId) };
    if (![ApprovalStatus.APPROVED, ApprovalStatus.AUTO_APPROVED].includes(clip.approvalStatus as never)) return 'SKIPPED';
    if (![UploadStatus.QUEUED, UploadStatus.UPLOADING].includes(clip.uploadStatus as never)) return 'SKIPPED';
    if (!clip.storageKey) throw new UnrecoverableError('Rendered file is missing');

    // Scheduled publishing: upload early as private and let YouTube make it public at the slot.
    const goLiveAt = clip.goLiveAt ?? (await this.deps.schedule?.assign(clipId)) ?? null;
    const scheduled = Boolean(goLiveAt && goLiveAt.getTime() > Date.now() + IMMEDIATE_WITHIN_MS);
    // Without a slot, the upload limit, spacing and window decide when it goes up.
    const slot = goLiveAt ? null : await this.nextSlot();
    if (slot) {
      await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { scheduledPublishAt: slot } });
      return await ctx.defer(slot, 'Waiting for the upload limit / spacing in Settings → Publishing');
    }

    const { publishing } = (await this.deps.settings.getValues()).values;
    const transcript = await TranscriptModel.findOne({ liveSessionId: clip.liveSessionId }).select('language').lean();
    await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { uploadStatus: UploadStatus.UPLOADING, scheduledPublishAt: null } });

    const work = path.join(this.deps.workDir, `upload-${clipId}`);
    await fsp.mkdir(work, { recursive: true });
    try {
      const video = path.join(work, 'short.mp4');
      await this.deps.storage.download(clip.storageKey, video);
      const input = {
        filePath: video,
        metadata: {
          title: clip.title,
          description: clip.description,
          tags: clip.tags,
          categoryId: publishing.categoryId || '20',
          privacyStatus: scheduled ? 'private' : goLiveAt ? 'public' : publishing.privacyStatus,
          publishAt: scheduled ? goLiveAt : null,
          language: languageCode(transcript?.language),
        },
        resumeUrl: clip.resumableUploadUrl ?? null,
        onSession: async (url: string) => {
          await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { resumableUploadUrl: url } });
        },
        onProgress: (f: number) => ctx.onProgress?.(Math.round(10 + f * 85)),
      };
      const token = () => this.deps.account.accessToken();
      let result: { videoId: string };
      try {
        result = await this.deps.uploader.upload(input, token);
      } catch (err) {
        if (!(err instanceof YouTubePublishError && err.code === 'AUTH')) throw err;
        this.deps.account.invalidate(); // expired access token: refresh once and resume
        result = await this.deps.uploader.upload({ ...input, resumeUrl: (await GeneratedClipModel.findById(clipId).select('+resumableUploadUrl').lean())?.resumableUploadUrl ?? null }, token);
      }

      const url = youtubeShortUrl(result.videoId);
      await GeneratedClipModel.updateOne(
        { _id: clipId },
        { $set: { youtubeVideoId: result.videoId, youtubeUrl: url, uploadStatus: UploadStatus.PUBLISHED, publishedAt: scheduled ? goLiveAt : new Date(), resumableUploadUrl: null, lastError: null } },
      );
      this.deps.logger?.info({ clipId, videoId: result.videoId, uploader: this.deps.uploader.name, goLiveAt: scheduled ? goLiveAt : null }, scheduled ? 'Short uploaded, scheduled to go public' : 'Short uploaded');

      if (clip.thumbnailKey) {
        // Custom thumbnails need a verified channel; failure here never fails the upload.
        const thumb = path.join(work, 'thumb.jpg');
        await this.deps.storage
          .download(clip.thumbnailKey, thumb)
          .then(() => this.deps.uploader.setThumbnail(result.videoId, thumb, token))
          .catch((err: Error) => this.deps.logger?.warn({ clipId, err: err.message }, 'Thumbnail not set'));
      }
      return { videoId: result.videoId, url };
    } catch (err) {
      if (err instanceof YouTubePublishError) {
        if (err.retryAfterMs) {
          await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { uploadStatus: UploadStatus.QUEUED, lastError: err.message } });
          return await ctx.defer(new Date(Date.now() + err.retryAfterMs), err.message);
        }
        if (!err.retryable) {
          await this.markFailed(clipId, err.message);
          throw new UnrecoverableError(err.message);
        }
      }
      await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { uploadStatus: UploadStatus.QUEUED, lastError: (err as Error).message.slice(0, 500) } });
      throw err;
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async markFailed(clipId: string, message: string) {
    await GeneratedClipModel.updateOne(
      { _id: clipId, uploadStatus: { $ne: UploadStatus.PUBLISHED } },
      { $set: { uploadStatus: UploadStatus.UPLOAD_FAILED, lastError: message.slice(0, 500), scheduledPublishAt: null } },
    );
  }
}
