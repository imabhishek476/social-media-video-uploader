import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { GeneratedClipModel, HighlightCandidateModel, IntegrationCredentialModel, LiveSessionModel, StreamerChannelModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { LocalObjectStorage, YouTubePublishError, type YouTubeOAuthClient, type YouTubeUploader } from '@shorts/integrations';
import { MockYouTubeUploader, TemplateMetadataGenerator } from '@shorts/integrations/testing';
import type { QueueRegistry, Redis } from '@shorts/queue';
import { PublishService, ScheduleService, SettingsService, UploadService, YouTubeAccountService, bestHours, languageCode, localDay, planSlot } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_publish_test';
const ADMIN = String(new mongoose.Types.ObjectId());
const KEY = 'a'.repeat(64);

let root: string;
let storage: LocalObjectStorage;
let settings: SettingsService;
const enqueued: Array<{ queue: string; key: string; data: unknown }> = [];
const queues = { enqueue: async (queue: string, _n: string, data: unknown, key: string) => void enqueued.push({ queue, key, data }) } as unknown as QueueRegistry;

/** Minimal in-memory stand-in for the two Redis calls the account service makes. */
function fakeRedis() {
  const m = new Map<string, string>();
  return { set: async (k: string, v: string) => void m.set(k, v), getdel: async (k: string) => { const v = m.get(k) ?? null; m.delete(k); return v; } } as unknown as Redis;
}

class Deferred extends Error {
  constructor(public readonly until: Date) {
    super('deferred');
  }
}
const ctx = { defer: async (until: Date): Promise<never> => { throw new Deferred(until); } };

async function renderedClip(title = '') {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'p')}`, channelUrl: 'https://x', displayName: 'Mock Gamer' });
  const s = await LiveSessionModel.create({ streamerChannelId: ch._id, broadcastId: `b${Math.random().toString(36).slice(2, 9)}`, title: 'GTA night' });
  const cand = await HighlightCandidateModel.create({ liveSessionId: s._id, startSeconds: 0, endSeconds: 30, score: 80, hook: 'No way he made that jump', reason: 'Big reaction', status: 'SELECTED' });
  const clip = await GeneratedClipModel.create({ liveSessionId: s._id, streamerChannelId: ch._id, highlightCandidateId: cand._id, startSeconds: 0, endSeconds: 30, durationSeconds: 30, renderStatus: 'RENDERED', storageKey: `clips/${s._id}/x/v1.mp4`, title });
  await fs.mkdir(path.join(root, 'objects', 'clips', String(s._id), 'x'), { recursive: true });
  await fs.writeFile(path.join(root, 'objects', clip.storageKey!), Buffer.alloc(1234, 1));
  return { sessionId: String(s._id), clipId: String(clip._id) };
}

function services(uploader: YouTubeUploader = new MockYouTubeUploader()) {
  const account = new YouTubeAccountService({ oauth: null, redis: fakeRedis() });
  return {
    uploader,
    publish: new PublishService({ settings, queues, account, metadata: new TemplateMetadataGenerator() }),
    upload: new UploadService({ settings, storage, account, uploader, workDir: path.join(root, 'work') }),
  };
}

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-publish-'));
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
  await settings.update({ publishing: { mode: 'MANUAL_APPROVAL', dailyUploadLimit: 10, minMinutesBetweenUploads: 0, privacyStatus: 'private', timingMode: 'BEST_TIME', skipDays: '', maxPerSourcePerDay: 2 } }, ADMIN);
  // A connected central channel (approval requires one).
  await IntegrationCredentialModel.create({ provider: 'youtube', accountId: 'UCcentral', encryptedRefreshToken: 'x', status: 'ACTIVE' });
});

describe('metadata and approval', () => {
  it('writes metadata after rendering and waits for approval in manual mode', async () => {
    const { sessionId, clipId } = await renderedClip();
    const { publish } = services();
    expect(await publish.prepareSession(sessionId)).toEqual({ generated: 1, autoApproved: 0, failed: 0 });
    const c = (await GeneratedClipModel.findById(clipId).lean())!;
    expect(c.title).toBe('No way he made that jump');
    expect(c.description).toContain("From Mock Gamer's stream");
    expect(c.approvalStatus).toBe('PENDING');
    expect(enqueued).toEqual([]);
  });

  it('auto-approves and queues uploads in AUTO_PUBLISH mode', async () => {
    await settings.update({ publishing: { mode: 'AUTO_PUBLISH' } }, ADMIN);
    const { sessionId, clipId } = await renderedClip();
    expect(await services().publish.prepareSession(sessionId)).toMatchObject({ autoApproved: 1 });
    expect((await GeneratedClipModel.findById(clipId).lean())!).toMatchObject({ approvalStatus: 'AUTO_APPROVED', uploadStatus: 'QUEUED', uploadIdempotencyKey: `clip:${clipId}` });
    expect(enqueued).toEqual([expect.objectContaining({ queue: 'youtube-upload', data: expect.objectContaining({ clipId }) })]);
  });

  it('validates edits and blocks double approval', async () => {
    const { clipId } = await renderedClip('Title');
    const { publish } = services();
    await expect(publish.updateMetadata(clipId, { title: 'bad <title>' })).rejects.toThrow(/< or >/);
    await expect(publish.updateMetadata(clipId, { title: 'x'.repeat(101) })).rejects.toThrow(/1–100/);
    await publish.updateMetadata(clipId, { title: 'Good title', tags: ['a', 'a', ' b '] });
    expect((await GeneratedClipModel.findById(clipId).lean())!).toMatchObject({ title: 'Good title', tags: ['a', 'b'], metadataEditedByUser: true });
    await publish.approve(clipId, ADMIN);
    await expect(publish.approve(clipId, ADMIN)).rejects.toThrow(/already queued/);
    await expect(publish.updateMetadata(clipId, { title: 'late' })).resolves.toBeUndefined(); // QUEUED can still be edited
  });

  it('requires a connected channel', async () => {
    await IntegrationCredentialModel.deleteMany({});
    const { clipId } = await renderedClip('T');
    const account = new YouTubeAccountService({ oauth: null, redis: fakeRedis() });
    const publish = new PublishService({ settings, queues, account, metadata: new TemplateMetadataGenerator() });
    await expect(publish.approve(clipId, ADMIN)).rejects.toThrow(/Connect the central YouTube channel/);
  });
});

describe('UploadService', () => {
  it('uploads once and returns the same video on a repeated job', async () => {
    const { clipId } = await renderedClip('My Short');
    const s = services();
    await s.publish.approve(clipId, ADMIN);
    const first = await s.upload.upload(clipId, ctx);
    expect(first).toMatchObject({ videoId: expect.stringMatching(/^mock/), url: expect.stringContaining('youtube.com/shorts/') });
    expect((await GeneratedClipModel.findById(clipId).lean())!).toMatchObject({ uploadStatus: 'PUBLISHED', youtubeVideoId: (first as { videoId: string }).videoId });
    expect(await s.upload.upload(clipId, ctx)).toEqual(first);
    expect((s.uploader as MockYouTubeUploader).uploads).toHaveLength(1);
    expect((s.uploader as MockYouTubeUploader).uploads[0]!.metadata).toMatchObject({ title: 'My Short', privacyStatus: 'private', categoryId: '20' });
  });

  it('defers uploads beyond the daily limit and the minimum gap', async () => {
    await settings.update({ publishing: { dailyUploadLimit: 1 } }, ADMIN);
    const s = services();
    const a = await renderedClip('A');
    const b = await renderedClip('B');
    await s.publish.approve(a.clipId, ADMIN);
    await s.publish.approve(b.clipId, ADMIN);
    await s.upload.upload(a.clipId, ctx);
    const err = await s.upload.upload(b.clipId, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Deferred);
    expect((err as Deferred).until.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect((await GeneratedClipModel.findById(b.clipId).lean())!).toMatchObject({ uploadStatus: 'QUEUED', scheduledPublishAt: expect.any(Date) });

    await settings.update({ publishing: { dailyUploadLimit: 0, minMinutesBetweenUploads: 30 } }, ADMIN);
    const gap = (await s.upload.upload(b.clipId, ctx).catch((e: unknown) => e)) as Deferred;
    expect(gap.until.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
  });

  it('defers on quota errors and fails permanently on bad requests', async () => {
    const failing = (e: YouTubePublishError): YouTubeUploader => ({ name: 'youtube', upload: async () => { throw e; }, setThumbnail: async () => {} });
    const q = await renderedClip('Q');
    const sq = services(failing(new YouTubePublishError('QUOTA', 'quota', true, 3_600_000)));
    await sq.publish.approve(q.clipId, ADMIN);
    expect(await sq.upload.upload(q.clipId, ctx).catch((e: unknown) => e)).toBeInstanceOf(Deferred);
    expect((await GeneratedClipModel.findById(q.clipId).lean())!).toMatchObject({ uploadStatus: 'QUEUED', lastError: 'quota' });

    const bad = await renderedClip('B');
    const sb = services(failing(new YouTubePublishError('BAD_REQUEST', 'invalid title', false)));
    await sb.publish.approve(bad.clipId, ADMIN);
    await expect(sb.upload.upload(bad.clipId, ctx)).rejects.toThrow('invalid title');
    expect((await GeneratedClipModel.findById(bad.clipId).lean())!).toMatchObject({ uploadStatus: 'UPLOAD_FAILED' });
    // A failed upload can be retried by approving again.
    await sb.publish.approve(bad.clipId, ADMIN);
    expect((await GeneratedClipModel.findById(bad.clipId).lean())!).toMatchObject({ uploadStatus: 'QUEUED', uploadAttempts: 2 });
  });
});

describe('scheduled publishing', () => {
  const IST = 'Asia/Kolkata';
  const slots: Array<[number, number]> = [[12, 30], [18, 0], [21, 0]];

  it('picks the next free slot in the channel time zone, skipping taken slots and days', () => {
    const now = new Date('2026-11-26T08:00:00Z'); // 13:30 IST, Thursday
    const first = planSlot({ now, timeZone: IST, slots, skipDays: [], taken: [], sameSource: [], maxPerSourcePerDay: 0 });
    expect(first!.toISOString()).toBe('2026-11-26T12:30:00.000Z'); // 18:00 IST
    const second = planSlot({ now, timeZone: IST, slots, skipDays: [], taken: [first!], sameSource: [], maxPerSourcePerDay: 0 });
    expect(second!.toISOString()).toBe('2026-11-26T15:30:00.000Z'); // 21:00 IST
    // Friday skipped -> Saturday 12:30 IST
    const third = planSlot({ now, timeZone: IST, slots, skipDays: [5], taken: [first!, second!], sameSource: [], maxPerSourcePerDay: 0 });
    expect(third!.toISOString()).toBe('2026-11-28T07:00:00.000Z');
  });

  it('spreads one stream over days with maxPerSourcePerDay', () => {
    const now = new Date('2026-11-26T02:00:00Z'); // 07:30 IST
    const a = planSlot({ now, timeZone: IST, slots, skipDays: [], taken: [], sameSource: [], maxPerSourcePerDay: 2 })!;
    const b = planSlot({ now, timeZone: IST, slots, skipDays: [], taken: [a], sameSource: [a], maxPerSourcePerDay: 2 })!;
    const c = planSlot({ now, timeZone: IST, slots, skipDays: [], taken: [a, b], sameSource: [a, b], maxPerSourcePerDay: 2 })!;
    expect(localDay(a, IST)).toBe('2026-11-26');
    expect(localDay(b, IST)).toBe('2026-11-26');
    expect(localDay(c, IST)).toBe('2026-11-27');
  });

  it('learns best hours only with enough data', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 10, 1, h, 0)); // UTC hours
    const rows = [...Array(12)].flatMap((_, i) => [{ at: at(13), views: 900 + i }, { at: at(3), views: 100 }, { at: at(16), views: 500 }]);
    expect(bestHours(rows.slice(0, 10), 'UTC', 2)).toBeNull();
    expect(bestHours(rows, 'UTC', 2)).toEqual([[13, 0], [16, 0]]);
  });

  it('approval assigns a slot; the upload goes up early as private with publishAt', async () => {
    await settings.update({ publishing: { privacyStatus: 'public', timingMode: 'FIXED_SLOTS', slotTimes: '00:00, 06:00, 12:00, 18:00', timezone: 'UTC' } }, ADMIN);
    const uploader = new MockYouTubeUploader();
    const account = new YouTubeAccountService({ oauth: null, redis: fakeRedis() });
    const schedule = new ScheduleService({ settings });
    const publish = new PublishService({ settings, queues, account, metadata: new TemplateMetadataGenerator(), schedule });
    const upload = new UploadService({ settings, storage, account, uploader, workDir: path.join(root, 'work'), schedule });
    const { clipId } = await renderedClip('Scheduled');
    await publish.approve(clipId, ADMIN);
    const slot = (await GeneratedClipModel.findById(clipId).lean())!.goLiveAt!;
    expect(slot.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);
    expect([0, 6, 12, 18]).toContain(slot.getUTCHours());

    await upload.upload(clipId, ctx);
    expect(uploader.uploads[0]!.metadata).toMatchObject({ privacyStatus: 'private', publishAt: slot });
    const after = (await GeneratedClipModel.findById(clipId).lean())!;
    expect(after.uploadStatus).toBe('PUBLISHED');
    expect(after.publishedAt!.getTime()).toBe(slot.getTime());

    const cal = await schedule.list();
    expect(cal.items.find((i) => i.id === clipId)).toMatchObject({ uploaded: true });
  });

  it('IMMEDIATE mode and private uploads get no slot', async () => {
    const schedule = new ScheduleService({ settings });
    const { clipId } = await renderedClip('x');
    expect(await schedule.assign(clipId)).toBeNull(); // privacy is private
    await settings.update({ publishing: { privacyStatus: 'public', timingMode: 'IMMEDIATE' } }, ADMIN);
    expect(await schedule.assign(clipId)).toBeNull();
  });
});

describe('YouTubeAccountService', () => {
  const fakeOAuth = (refreshError?: Error) =>
    ({
      authUrl: (state: string) => `https://accounts.google.com/auth?state=${state}`,
      exchangeCode: async () => ({ accessToken: 'at', refreshToken: 'rt-secret', expiresAt: Date.now() + 3600_000, scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' }),
      refresh: async () => {
        if (refreshError) throw refreshError;
        return { accessToken: 'at-2', expiresAt: Date.now() + 3600_000, scope: '' };
      },
      revoke: async () => {},
      channel: async () => ({ id: 'UCcentral', title: 'Central' }),
    }) as unknown as YouTubeOAuthClient;

  it('connects with a single-use state and stores the refresh token encrypted', async () => {
    await IntegrationCredentialModel.deleteMany({});
    const acc = new YouTubeAccountService({ oauth: fakeOAuth(), redis: fakeRedis(), encryptionKey: KEY });
    const state = new URL(await acc.startConnect(ADMIN)).searchParams.get('state')!;
    expect(await acc.completeConnect(state, 'code')).toEqual({ channelId: 'UCcentral', channelTitle: 'Central' });
    await expect(acc.completeConnect(state, 'code')).rejects.toThrow(/expired or was already used/);
    const cred = (await IntegrationCredentialModel.findOne({ provider: 'youtube' }).select('+encryptedRefreshToken').lean())!;
    expect(cred).toMatchObject({ accountId: 'UCcentral', status: 'ACTIVE' });
    expect(cred.encryptedRefreshToken).not.toContain('rt-secret');
    expect(await acc.isConnected()).toBe(true);

    const fresh = new YouTubeAccountService({ oauth: fakeOAuth(), redis: fakeRedis(), encryptionKey: KEY });
    expect(await fresh.accessToken()).toBe('at-2');
  });

  it('marks the connection for reconnect when Google revokes it', async () => {
    const ok = new YouTubeAccountService({ oauth: fakeOAuth(), redis: fakeRedis(), encryptionKey: KEY });
    await ok.completeConnect(new URL(await ok.startConnect(ADMIN)).searchParams.get('state')!, 'c');
    const revoked = new YouTubeAccountService({ oauth: fakeOAuth(new YouTubePublishError('RECONNECT', 'revoked', false)), redis: fakeRedis(), encryptionKey: KEY });
    await expect(revoked.accessToken()).rejects.toMatchObject({ code: 'RECONNECT' });
    expect((await IntegrationCredentialModel.findOne({ provider: 'youtube' }).lean())!).toMatchObject({ status: 'ERROR', lastError: 'revoked' });
    expect(await revoked.isConnected()).toBe(false);
  });

  it('maps transcript languages to YouTube language codes', () => {
    expect(languageCode('English')).toBe('en');
    expect(languageCode('hi')).toBe('hi');
    expect(languageCode('klingon')).toBeUndefined();
  });
});
