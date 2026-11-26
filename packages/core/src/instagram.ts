import fsp from 'node:fs/promises';
import path from 'node:path';
import { decryptSecret, encryptSecret } from '@shorts/config';
import { GeneratedClipModel, IntegrationCredentialModel, mongoose } from '@shorts/database';
import { InstagramPublishError, isFacebookToken, reelCaption, type InstagramGraphClient, type ObjectStorage } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { UnrecoverableError, idempotencyKey, type QueueRegistry } from '@shorts/queue';
import { JobType, RenderStatus, type InstagramConnectionDTO } from '@shorts/shared-types';
import { DomainError } from './errors';
import { enqueueTracked } from './jobs';
import { nextWindowOpen } from './scheduling';
import type { SettingsService } from './settings';

const PROVIDER = 'instagram';
/** Refresh the long-lived token when it has less than this left (tokens last 60 days). */
const REFRESH_WITHIN_MS = 20 * 86_400_000;

/** Holds the one Instagram Business/Creator account (encrypted long-lived token). */
export class InstagramAccountService {
  constructor(private readonly deps: { client: InstagramGraphClient; encryptionKey?: string; logger?: Logger }) {}

  private key(): string {
    if (!this.deps.encryptionKey) throw new DomainError('INSTAGRAM_NOT_CONFIGURED', 'Set ENCRYPTION_KEY before connecting Instagram.', 400);
    return this.deps.encryptionKey;
  }

  /** Verify a pasted long-lived token and store it. */
  async connect(accessToken: string, userId: string | null): Promise<InstagramConnectionDTO> {
    const key = this.key();
    let me;
    try {
      me = await this.deps.client.me(accessToken.trim());
    } catch (err) {
      throw new DomainError('INSTAGRAM_TOKEN_INVALID', `Instagram rejected this token: ${(err as Error).message}`, 400);
    }
    if (!me.userId) throw new DomainError('INSTAGRAM_TOKEN_INVALID', 'Instagram did not return an account for this token.', 400);
    if (me.accountType && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(me.accountType)) {
      throw new DomainError('INSTAGRAM_ACCOUNT_TYPE', 'Reels can only be published from a Business or Creator account.', 400);
    }
    await IntegrationCredentialModel.findOneAndUpdate(
      { provider: PROVIDER },
      {
        $set: {
          accountId: me.userId,
          accountTitle: me.username,
          scopes: [],
          encryptedRefreshToken: encryptSecret(accessToken.trim(), key),
          // Unknown until the first refresh; assume a fresh 60-day token.
          tokenExpiresAt: new Date(Date.now() + 59 * 86_400_000),
          status: 'ACTIVE',
          lastError: null,
          connectedBy: userId && mongoose.isValidObjectId(userId) ? userId : null,
          connectedAt: new Date(),
        },
      },
      { upsert: true },
    );
    this.deps.logger?.info({ username: me.username }, 'Instagram account connected');
    return this.status();
  }

  async disconnect(): Promise<void> {
    await IntegrationCredentialModel.deleteOne({ provider: PROVIDER });
  }

  async status(): Promise<InstagramConnectionDTO> {
    const c = await IntegrationCredentialModel.findOne({ provider: PROVIDER }).lean();
    return {
      connected: c?.status === 'ACTIVE',
      status: (c?.status as InstagramConnectionDTO['status']) ?? null,
      userId: c?.accountId ?? null,
      username: c?.accountTitle ?? null,
      tokenExpiresAt: c?.tokenExpiresAt ? c.tokenExpiresAt.toISOString() : null,
      lastError: c?.lastError ?? null,
    };
  }

  async isConnected(): Promise<boolean> {
    return Boolean(await IntegrationCredentialModel.exists({ provider: PROVIDER, status: 'ACTIVE' }));
  }

  async credentials(): Promise<{ token: string; userId: string }> {
    const c = await IntegrationCredentialModel.findOne({ provider: PROVIDER }).select('+encryptedRefreshToken').lean();
    if (!c || c.status !== 'ACTIVE' || !c.accountId) throw new InstagramPublishError('AUTH', 'No Instagram account is connected. Connect it in Settings.', false);
    return { token: decryptSecret(c.encryptedRefreshToken, this.key()), userId: c.accountId };
  }

  async markError(message: string) {
    await IntegrationCredentialModel.updateOne({ provider: PROVIDER }, { $set: { status: 'ERROR', lastError: message.slice(0, 500) } });
  }

  /** Keep the 60-day token alive (run daily). */
  async refreshIfNeeded(now = new Date()): Promise<'REFRESHED' | 'NOT_NEEDED' | 'NOT_CONNECTED'> {
    const c = await IntegrationCredentialModel.findOne({ provider: PROVIDER, status: 'ACTIVE' }).select('+encryptedRefreshToken').lean();
    if (!c) return 'NOT_CONNECTED';
    if (c.tokenExpiresAt && c.tokenExpiresAt.getTime() - now.getTime() > REFRESH_WITHIN_MS) return 'NOT_NEEDED';
    if (isFacebookToken(decryptSecret(c.encryptedRefreshToken, this.key()))) {
      if (c.tokenExpiresAt && c.tokenExpiresAt <= now) await this.markError('The Instagram (Facebook Login) token has expired. Paste a new one in Settings.');
      return 'NOT_NEEDED';
    }
    try {
      const r = await this.deps.client.refresh(decryptSecret(c.encryptedRefreshToken, this.key()));
      await IntegrationCredentialModel.updateOne({ provider: PROVIDER }, { $set: { encryptedRefreshToken: encryptSecret(r.token, this.key()), tokenExpiresAt: r.expiresAt, lastError: null } });
      return 'REFRESHED';
    } catch (err) {
      if (err instanceof InstagramPublishError && err.code === 'AUTH') await this.markError(err.message);
      throw err;
    }
  }
}

export type InstagramOutcome = { mediaId: string | null; permalink: string | null } | 'SKIPPED';

/** How long one job waits for Instagram to process the video before deferring. */
const PROCESS_WAIT_MS = 4 * 60_000;

/** Posts rendered Shorts as Instagram Reels. Independent of the YouTube upload state. */
export class InstagramPublishService {
  constructor(
    private readonly deps: {
      settings: SettingsService;
      storage: ObjectStorage;
      queues: QueueRegistry;
      account: InstagramAccountService;
      client: InstagramGraphClient;
      workDir: string;
      logger?: Logger;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /** Queue a Reel for a rendered clip (also retries a failed one). */
  async queue(clipId: string): Promise<void> {
    if (!mongoose.isValidObjectId(clipId)) throw DomainError.notFound('Clip');
    const clip = await GeneratedClipModel.findById(clipId).lean();
    if (!clip) throw DomainError.notFound('Clip');
    if (clip.renderStatus !== RenderStatus.RENDERED || !clip.storageKey) throw new DomainError('CLIP_NOT_RENDERED', 'Render the clip before posting it', 409);
    if (!clip.title.trim()) throw new DomainError('METADATA_MISSING', 'Add a title before posting', 409);
    if (!(await this.deps.account.isConnected())) throw new DomainError('INSTAGRAM_NOT_CONNECTED', 'Connect Instagram in Settings first', 409);
    const status = clip.instagram?.status ?? 'NOT_POSTED';
    if (!['NOT_POSTED', 'FAILED'].includes(status)) throw new DomainError('ALREADY_QUEUED', 'This Reel is already queued, posting or published', 409);
    const attempt = (clip.instagram?.attempts ?? 0) + 1;
    const res = await GeneratedClipModel.updateOne(
      { _id: clipId, $or: [{ instagram: null }, { 'instagram.status': { $in: ['NOT_POSTED', 'FAILED'] } }] },
      {
        $set: {
          instagram: {
            status: 'QUEUED',
            attempts: attempt,
            containerId: clip.instagram?.containerId ?? null,
            uploaded: clip.instagram?.uploaded ?? false,
            mediaId: null,
            permalink: null,
            publishedAt: null,
            lastError: null,
          },
        },
      },
    );
    if (!res.modifiedCount) throw new DomainError('ALREADY_QUEUED', 'This Reel is already queued, posting or published', 409);
    await enqueueTracked(this.deps.queues, {
      jobType: JobType.INSTAGRAM_UPLOAD,
      jobName: 'post-reel',
      key: idempotencyKey('clip', clipId, 'instagram', attempt),
      entityType: 'GeneratedClip',
      entityId: clipId,
      data: { clipId },
    });
  }

  /** Called after YouTube approval: queue the Reel too when Settings say so. Never throws. */
  async queueWithYouTube(clipId: string): Promise<boolean> {
    const { publishing } = (await this.deps.settings.getValues()).values;
    if (publishing.instagramMode !== 'WITH_YOUTUBE' || !(await this.deps.account.isConnected())) return false;
    return this.queue(clipId).then(
      () => true,
      (err: Error) => {
        this.deps.logger?.warn({ clipId, err: err.message }, 'Instagram cross-post not queued');
        return false;
      },
    );
  }

  async post(clipId: string, ctx: { defer: (until: Date, reason: string) => Promise<never>; onProgress?: (pct: number) => Promise<void> }): Promise<InstagramOutcome> {
    const { client, account, logger } = this.deps;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const clip = await GeneratedClipModel.findById(clipId).lean();
    if (!clip?.instagram) return 'SKIPPED';
    const ig = clip.instagram;
    if (ig.status === 'PUBLISHED') return { mediaId: ig.mediaId ?? null, permalink: ig.permalink ?? null };
    if (!['QUEUED', 'POSTING'].includes(ig.status ?? '')) return 'SKIPPED';
    if (!clip.storageKey) throw new UnrecoverableError('Rendered file is missing');

    const { publishing } = (await this.deps.settings.getValues()).values;
    // A scheduled Short goes to Instagram at its YouTube slot; otherwise follow the publish window.
    if (clip.goLiveAt && publishing.instagramTiming !== 'IMMEDIATE') {
      if (clip.goLiveAt.getTime() > Date.now()) return await ctx.defer(clip.goLiveAt, 'Waiting for the Short\'s publish slot');
    } else if (!clip.goLiveAt) {
      const open = nextWindowOpen(new Date(), publishing.windowStartHour, publishing.windowEndHour, publishing.timezone);
      if (open) return await ctx.defer(open, 'Waiting for the publish window in Settings → Publishing');
    }

    const set = (fields: Record<string, unknown>) =>
      GeneratedClipModel.updateOne({ _id: clipId }, { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`instagram.${k}`, v])) });

    await set({ status: 'POSTING' });
    const work = path.join(this.deps.workDir, `instagram-${clipId}`);
    try {
      const { token, userId } = await account.credentials();
      let containerId = ig.containerId ?? null;

      // Resume a container only if its video upload finished; otherwise it can never be processed.
      if (containerId && !ig.uploaded) containerId = null;
      if (containerId) {
        const st = await client.containerStatus(token, containerId);
        if (st.status === 'PUBLISHED') {
          await set({ status: 'PUBLISHED', publishedAt: new Date(), lastError: null });
          return { mediaId: null, permalink: null };
        }
        if (st.status === 'ERROR' || st.status === 'EXPIRED') containerId = null;
      }
      if (!containerId) {
        containerId = await client.createReelContainer(token, userId, reelCaption(clip.title, clip.description, clip.tags));
        await set({ containerId, uploaded: false });
        await fsp.mkdir(work, { recursive: true });
        const video = path.join(work, 'reel.mp4');
        await this.deps.storage.download(clip.storageKey, video);
        await ctx.onProgress?.(20);
        try {
          await client.uploadVideo(token, containerId, video);
        } catch (err) {
          // Meta sometimes rejects a retry because the first attempt actually arrived.
          // If the container is processing or ready, carry on; otherwise start over next time.
          const st = await client.containerStatus(token, containerId).catch(() => null);
          if (!st || (st.status !== 'IN_PROGRESS' && st.status !== 'FINISHED')) {
            await set({ containerId: null, uploaded: false });
            throw err;
          }
          logger?.warn({ clipId, containerId, status: st.status }, 'Instagram upload reported an error but the container has the video; continuing');
        }
        await set({ uploaded: true });
        await ctx.onProgress?.(60);
      }

      // Instagram transcodes the video before it can be published.
      const deadline = Date.now() + PROCESS_WAIT_MS;
      for (;;) {
        const st = await client.containerStatus(token, containerId);
        if (st.status === 'FINISHED') break;
        if (st.status === 'ERROR' || st.status === 'EXPIRED') {
          await set({ containerId: null, uploaded: false });
          throw new InstagramPublishError('BAD_REQUEST', `Instagram could not process the video: ${st.message ?? st.status}`, false);
        }
        if (Date.now() > deadline) return await ctx.defer(new Date(Date.now() + 60_000), 'Instagram is still processing the video');
        await sleep(5000);
      }
      await ctx.onProgress?.(85);

      const mediaId = await client.publish(token, userId, containerId);
      const permalink = await client.permalink(token, mediaId);
      await set({ status: 'PUBLISHED', mediaId, permalink, publishedAt: new Date(), lastError: null });
      logger?.info({ clipId, mediaId }, 'Reel published');
      return { mediaId, permalink };
    } catch (err) {
      if (err instanceof InstagramPublishError) {
        if (err.code === 'AUTH') await account.markError(err.message);
        if (err.retryAfterMs) {
          await set({ status: 'QUEUED', lastError: err.message });
          return await ctx.defer(new Date(Date.now() + err.retryAfterMs), err.message);
        }
        if (!err.retryable) {
          await this.markFailed(clipId, err.message);
          throw new UnrecoverableError(err.message);
        }
      }
      if ((err as Error)?.name !== 'DelayedError') await set({ status: 'QUEUED', lastError: (err as Error).message.slice(0, 500) });
      throw err;
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async markFailed(clipId: string, message: string) {
    await GeneratedClipModel.updateOne(
      { _id: clipId, 'instagram.status': { $ne: 'PUBLISHED' } },
      { $set: { 'instagram.status': 'FAILED', 'instagram.lastError': message.slice(0, 500) } },
    );
  }
}
