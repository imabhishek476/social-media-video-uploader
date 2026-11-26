import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { GeneratedClipModel, HighlightCandidateModel, IntegrationCredentialModel, LiveSessionModel, StreamerChannelModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { InstagramPublishError, LocalObjectStorage, reelCaption, type ContainerStatus, type InstagramGraphClient } from '@shorts/integrations';
import { TemplateMetadataGenerator } from '@shorts/integrations/testing';
import type { QueueRegistry, Redis } from '@shorts/queue';
import { InstagramAccountService, InstagramPublishService, PublishService, SettingsService, YouTubeAccountService } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI_IG ?? 'mongodb://localhost:27017/ai_shorts_core_instagram_test';
const KEY = 'b'.repeat(64);
const ADMIN = String(new mongoose.Types.ObjectId());

class FakeIg {
  calls: string[] = [];
  statuses: ContainerStatus[] = [];
  failPublish: InstagramPublishError | null = null;
  tokenValid = true;
  async me(token: string) {
    if (!this.tokenValid) throw new InstagramPublishError('AUTH', 'bad token', false);
    return { userId: '1784', username: `creator_${token.slice(0, 3)}`, accountType: 'MEDIA_CREATOR' };
  }
  async refresh() {
    this.calls.push('refresh');
    return { token: 'refreshed-token-xxxxxxxxxxxxxxxx', expiresAt: new Date(Date.now() + 60 * 86_400_000) };
  }
  async createReelContainer(_t: string, userId: string, caption: string) {
    this.calls.push(`create:${userId}:${caption}`);
    return 'C1';
  }
  async uploadVideo(_t: string, id: string, file: string) {
    this.calls.push(`upload:${id}:${(await fs.stat(file)).size}`);
  }
  async containerStatus() {
    return { status: this.statuses.shift() ?? 'FINISHED', message: null };
  }
  async publish(_t: string, _u: string, id: string) {
    if (this.failPublish) throw this.failPublish;
    this.calls.push(`publish:${id}`);
    return 'M1';
  }
  async permalink() {
    return 'https://www.instagram.com/reel/abc/';
  }
}

let root: string;
let storage: LocalObjectStorage;
let settings: SettingsService;
let ig: FakeIg;
let account: InstagramAccountService;
let service: InstagramPublishService;
const enqueued: Array<{ queue: string; key: string }> = [];
const queues = { enqueue: async (queue: string, _n: string, _d: unknown, key: string) => void enqueued.push({ queue, key }) } as unknown as QueueRegistry;
class Deferred extends Error {}
const ctx = { defer: async (): Promise<never> => { throw new Deferred('deferred'); } };

async function renderedClip() {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'i')}`, channelUrl: 'https://x', displayName: 'Gamer' });
  const s = await LiveSessionModel.create({ streamerChannelId: ch._id, broadcastId: `b${Math.random().toString(36).slice(2, 9)}` });
  const cand = await HighlightCandidateModel.create({ liveSessionId: s._id, startSeconds: 0, endSeconds: 30, score: 80, status: 'SELECTED' });
  const clip = await GeneratedClipModel.create({
    liveSessionId: s._id, streamerChannelId: ch._id, highlightCandidateId: cand._id, startSeconds: 0, endSeconds: 30, durationSeconds: 30,
    renderStatus: 'RENDERED', storageKey: `clips/${s._id}/v1.mp4`, title: 'Insane jump', description: 'What a play #gta', tags: ['gta', 'Gaming Clips'],
  });
  await fs.mkdir(path.join(root, 'objects', 'clips', String(s._id)), { recursive: true });
  await fs.writeFile(path.join(root, 'objects', clip.storageKey!), Buffer.alloc(321, 1));
  return String(clip._id);
}

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-ig-'));
  storage = new LocalObjectStorage(path.join(root, 'objects'));
  settings = new SettingsService(parseConfig({ NODE_ENV: 'test' }));
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  enqueued.length = 0;
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  ig = new FakeIg();
  const client = ig as unknown as InstagramGraphClient;
  account = new InstagramAccountService({ client, encryptionKey: KEY });
  service = new InstagramPublishService({ settings, storage, queues, account, client, workDir: path.join(root, 'work'), sleep: async () => undefined });
});

describe('Instagram account', () => {
  it('stores the token encrypted, reports status and refreshes near expiry', async () => {
    const st = await account.connect('abc-long-lived-token-123456', ADMIN);
    expect(st).toMatchObject({ connected: true, username: 'creator_abc', userId: '1784' });
    const raw = await IntegrationCredentialModel.findOne({ provider: 'instagram' }).select('+encryptedRefreshToken').lean();
    expect(raw!.encryptedRefreshToken).not.toContain('abc-long-lived');
    expect(await account.refreshIfNeeded()).toBe('NOT_NEEDED');
    expect(await account.refreshIfNeeded(new Date(Date.now() + 50 * 86_400_000))).toBe('REFRESHED');
    expect((await account.credentials()).token).toBe('refreshed-token-xxxxxxxxxxxxxxxx');

    ig.tokenValid = false;
    await expect(account.connect('bad-token-xxxxxxxxxxxxxxxx', ADMIN)).rejects.toThrow(/rejected this token/);
  });
});

describe('Reel posting', () => {
  it('queues, uploads, waits for processing and publishes once', async () => {
    const id = await renderedClip();
    await expect(service.queue(id)).rejects.toThrow(/Connect Instagram/);
    await account.connect('abc-long-lived-token-123456', ADMIN);
    await service.queue(id);
    await expect(service.queue(id)).rejects.toThrow(/already queued/);
    expect(enqueued[0]).toMatchObject({ queue: 'instagram-upload' });

    ig.statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    expect(await service.post(id, ctx)).toEqual({ mediaId: 'M1', permalink: 'https://www.instagram.com/reel/abc/' });
    expect(ig.calls).toEqual([`create:1784:${reelCaption('Insane jump', 'What a play #gta', ['gta', 'Gaming Clips'])}`, 'upload:C1:321', 'publish:C1']);
    expect(ig.calls[0]).toContain('#GamingClips');
    expect(ig.calls[0].match(/#gta/g)).toHaveLength(1);

    // Re-running the job never posts twice.
    await service.post(id, ctx);
    expect(ig.calls.filter((c) => c.startsWith('publish'))).toHaveLength(1);
    const clip = await GeneratedClipModel.findById(id).lean();
    expect(clip!.instagram).toMatchObject({ status: 'PUBLISHED', mediaId: 'M1', containerId: 'C1' });
  });

  it('waits for the YouTube time, or posts straight away when Settings say so', async () => {
    const id = await renderedClip();
    await account.connect('abc-long-lived-token-123456', ADMIN);
    await GeneratedClipModel.updateOne({ _id: id }, { $set: { goLiveAt: new Date(Date.now() + 3 * 86_400_000) } });
    await service.queue(id);
    await settings.update({ publishing: { instagramTiming: 'SAME_AS_YOUTUBE' } }, ADMIN);
    await expect(service.post(id, ctx)).rejects.toBeInstanceOf(Deferred);
    expect(ig.calls).toHaveLength(0);

    await settings.update({ publishing: { instagramTiming: 'IMMEDIATE' } }, ADMIN);
    ig.statuses = ['FINISHED'];
    expect(await service.post(id, ctx)).toMatchObject({ mediaId: 'M1' });
    await settings.update({ publishing: { instagramTiming: 'SAME_AS_YOUTUBE' } }, ADMIN);
  });

  it('defers on the publishing limit and fails permanently on bad requests', async () => {
    const id = await renderedClip();
    await account.connect('abc-long-lived-token-123456', ADMIN);
    await service.queue(id);
    ig.failPublish = new InstagramPublishError('RATE_LIMITED', 'limit reached', true, 3_600_000);
    await expect(service.post(id, ctx)).rejects.toBeInstanceOf(Deferred);
    expect((await GeneratedClipModel.findById(id).lean())!.instagram).toMatchObject({ status: 'QUEUED', containerId: 'C1', lastError: 'limit reached' });

    // Retry resumes the finished container instead of uploading again.
    ig.failPublish = new InstagramPublishError('BAD_REQUEST', 'caption rejected', false);
    await expect(service.post(id, ctx)).rejects.toThrow(/caption rejected/);
    expect(ig.calls.filter((c) => c.startsWith('upload'))).toHaveLength(1);
    expect((await GeneratedClipModel.findById(id).lean())!.instagram?.status).toBe('FAILED');
  });

  it('cross-posts on approval only when Settings say so', async () => {
    const id = await renderedClip();
    await account.connect('abc-long-lived-token-123456', ADMIN);
    await IntegrationCredentialModel.create({ provider: 'youtube', accountId: 'UC', encryptedRefreshToken: 'x', status: 'ACTIVE' });
    const publish = new PublishService({
      settings,
      queues,
      account: new YouTubeAccountService({ oauth: null, redis: {} as Redis }),
      metadata: new TemplateMetadataGenerator(),
      afterApprove: (c) => service.queueWithYouTube(c),
    });
    await publish.approve(id, ADMIN);
    expect(enqueued.map((e) => e.queue)).toEqual(['youtube-upload']);

    const id2 = await renderedClip();
    await settings.update({ publishing: { instagramMode: 'WITH_YOUTUBE' } }, ADMIN);
    await publish.approve(id2, ADMIN);
    expect(enqueued.map((e) => e.queue)).toEqual(['youtube-upload', 'youtube-upload', 'instagram-upload']);
    await settings.update({ publishing: { instagramMode: 'MANUAL' } }, ADMIN);
  });
});
