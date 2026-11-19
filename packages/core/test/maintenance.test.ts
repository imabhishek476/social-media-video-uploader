import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { GeneratedClipModel, HighlightCandidateModel, LiveSessionModel, ProcessingJobModel, StreamerChannelModel, TranscriptChunkModel, TranscriptModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { LocalObjectStorage, MockYouTubeUploader, type Notifier } from '@shorts/integrations';
import type { Redis } from '@shorts/queue';
import {
  ClipService,
  NotificationService,
  SettingsService,
  UploadService,
  budgetStatus,
  nextWindowOpen,
  recoverStuckSessions,
  refreshVideoStats,
  startOfNextMonthUtc,
  sweepClipFiles,
  sweepDoneSources,
  sweepTranscripts,
  type YouTubeAccountService,
} from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_maint_test';
const ADMIN = String(new mongoose.Types.ObjectId());
const DAY = 86_400_000;

let root: string;
let storage: LocalObjectStorage;
let settings: SettingsService;

async function put(key: string) {
  await fs.mkdir(path.dirname(path.join(root, 'objects', key)), { recursive: true });
  await fs.writeFile(path.join(root, 'objects', key), 'x');
}

async function sessionWithClips(clips: Array<Record<string, unknown>>, sessionOver: Record<string, unknown> = {}) {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'm')}`, channelUrl: 'https://x', displayName: 'M' });
  const s = await LiveSessionModel.create({ streamerChannelId: ch._id, broadcastId: `b${Math.random().toString(36).slice(2, 9)}`, ...sessionOver });
  const key = `raw/${s._id}/source.mp4`;
  await put(key);
  await LiveSessionModel.updateOne({ _id: s._id }, { sourceMedia: { status: 'READY', storageKey: key, readyAt: new Date() } });
  const ids: string[] = [];
  for (const c of clips) {
    const cand = await HighlightCandidateModel.create({ liveSessionId: s._id, startSeconds: 0, endSeconds: 30, score: 70 });
    const vkey = `clips/${s._id}/${cand._id}/v1.mp4`;
    await put(vkey);
    const g = await GeneratedClipModel.create({ liveSessionId: s._id, streamerChannelId: ch._id, highlightCandidateId: cand._id, startSeconds: 0, endSeconds: 30, durationSeconds: 30, renderStatus: 'RENDERED', storageKey: vkey, ...c });
    ids.push(String(g._id));
  }
  return { sessionId: String(s._id), sourceKey: key, clipIds: ids };
}

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-maint-'));
  storage = new LocalObjectStorage(path.join(root, 'objects'));
  settings = new SettingsService(parseConfig({ NODE_ENV: 'test' }));
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

describe('publish window', () => {
  it('finds the next opening in the configured time zone', () => {
    const now = new Date('2026-11-19T02:00:00Z'); // 07:30 in Asia/Kolkata
    expect(nextWindowOpen(now, 17, 23, 'Asia/Kolkata')).toEqual(new Date('2026-11-19T11:30:00Z')); // 17:00 IST
    expect(nextWindowOpen(new Date('2026-11-19T12:00:00Z'), 17, 23, 'Asia/Kolkata')).toBeNull(); // 17:30 IST, inside
    expect(nextWindowOpen(new Date('2026-11-19T18:00:00Z'), 17, 23, 'Asia/Kolkata')).toEqual(new Date('2026-11-20T11:30:00Z')); // 23:30 → tomorrow
    expect(nextWindowOpen(now, 0, 24, 'Asia/Kolkata')).toBeNull();
  });

  it('delays uploads to the window', async () => {
    await settings.update({ publishing: { windowStartHour: 17, windowEndHour: 23, timezone: 'Asia/Kolkata', minMinutesBetweenUploads: 0 } }, ADMIN);
    const svc = new UploadService({ settings, storage, account: {} as YouTubeAccountService, uploader: new MockYouTubeUploader(), workDir: root });
    expect(await svc.nextSlot(new Date('2026-11-19T02:00:00Z'))).toEqual(new Date('2026-11-19T11:30:00Z'));
    expect(await svc.nextSlot(new Date('2026-11-19T12:00:00Z'))).toBeNull();
    await expect(settings.update({ publishing: { windowStartHour: 20, windowEndHour: 10 } }, ADMIN)).rejects.toThrow(/Invalid settings/);
    await expect(settings.update({ publishing: { timezone: 'Mars/Olympus' } }, ADMIN)).rejects.toThrow(/Invalid settings/);
  });
});

describe('budget', () => {
  it('reports month-to-date spend against the budget', async () => {
    await sessionWithClips([], { estimatedCostUsd: 0.6 });
    await sessionWithClips([], { estimatedCostUsd: 0.5 });
    expect(await budgetStatus(settings)).toMatchObject({ spentUsd: 1.1, budgetUsd: 0, exceeded: false });
    await settings.update({ costs: { monthlyBudgetUsd: 1 } }, ADMIN);
    const b = await budgetStatus(settings);
    expect(b).toMatchObject({ exceeded: true, resumesAt: startOfNextMonthUtc() });
    expect(b.resumesAt!.getUTCDate()).toBe(1);
  });
});

describe('retention sweeps', () => {
  it('deletes the recording once every Short is done and the grace period passed', async () => {
    await settings.update({ retention: { sourceAfterDoneDays: 3 } }, ADMIN);
    const old = new Date(Date.now() - 5 * DAY);
    const done = await sessionWithClips([{ uploadStatus: 'PUBLISHED', publishedAt: old }, { approvalStatus: 'REJECTED', approvedAt: old }]);
    const recent = await sessionWithClips([{ uploadStatus: 'PUBLISHED', publishedAt: new Date() }]);
    const pending = await sessionWithClips([{ uploadStatus: 'PUBLISHED', publishedAt: old }, {}]);

    expect(await sweepDoneSources({ settings, storage })).toEqual({ deleted: 1 });
    expect(await storage.exists(done.sourceKey)).toBe(false);
    expect((await LiveSessionModel.findById(done.sessionId).lean())!.sourceMedia).toMatchObject({ status: 'EXPIRED', storageKey: null });
    expect(await storage.exists(recent.sourceKey)).toBe(true);
    expect(await storage.exists(pending.sourceKey)).toBe(true);
  });

  it('deletes clip files of old published/rejected Shorts but keeps the record and link', async () => {
    await settings.update({ retention: { clipDays: 30 } }, ADMIN);
    const old = new Date(Date.now() - 40 * DAY);
    const s = await sessionWithClips([{ uploadStatus: 'PUBLISHED', publishedAt: old, youtubeUrl: 'https://youtube.com/shorts/x' }, { uploadStatus: 'PUBLISHED', publishedAt: new Date() }]);
    expect(await sweepClipFiles({ settings, storage })).toEqual({ deleted: 1 });
    const [a, b] = await Promise.all(s.clipIds.map((id) => GeneratedClipModel.findById(id).lean()));
    expect(a).toMatchObject({ storageKey: null, filesExpiredAt: expect.any(Date), youtubeUrl: 'https://youtube.com/shorts/x' });
    expect(b!.storageKey).not.toBeNull();
    await expect(new ClipService(storage).mediaUrls(s.clipIds[0]!, 60, () => '')).rejects.toMatchObject({ httpStatus: 410, code: 'CLIP_FILES_EXPIRED' });
    expect((await new ClipService(storage).listForSession(s.sessionId)).find((c) => c.id === s.clipIds[0])!.filesExpired).toBe(true);
  });

  it('drops old transcripts', async () => {
    await settings.update({ retention: { transcriptDays: 10 } }, ADMIN);
    const s = await sessionWithClips([]);
    const t = await TranscriptModel.create({ liveSessionId: s.sessionId, provider: 'mock', chunkCount: 1 });
    await TranscriptChunkModel.create({ transcriptId: t._id, liveSessionId: s.sessionId, index: 0, startSeconds: 0, endSeconds: 300 });
    await TranscriptModel.collection.updateOne({ _id: t._id }, { $set: { createdAt: new Date(Date.now() - 20 * DAY) } });
    expect(await sweepTranscripts({ settings })).toEqual({ deleted: 1 });
    expect(await TranscriptChunkModel.countDocuments()).toBe(0);
  });
});

describe('watchdog', () => {
  it('fails sessions stuck RUNNING without any live job, and leaves active ones alone', async () => {
    const stuck = await sessionWithClips([], { processingStatus: 'RUNNING', status: 'PROCESSING' });
    const active = await sessionWithClips([], { processingStatus: 'RUNNING', status: 'PROCESSING' });
    const old = new Date(Date.now() - 4 * 3600_000);
    await LiveSessionModel.collection.updateMany({}, { $set: { updatedAt: old } });
    await ProcessingJobModel.create({ idempotencyKey: 'k1', jobType: 'TRANSCRIPTION', queueName: 'transcription', entityType: 'LiveSession', entityId: active.sessionId, status: 'RUNNING' });

    expect(await recoverStuckSessions({})).toEqual([stuck.sessionId]);
    expect((await LiveSessionModel.findById(stuck.sessionId).lean())!).toMatchObject({ status: 'FAILED', processingStatus: 'FAILED', lastError: expect.stringMatching(/Reprocess/) });
    expect((await LiveSessionModel.findById(active.sessionId).lean())!.processingStatus).toBe('RUNNING');
  });
});

describe('YouTube stats', () => {
  it('stores views and marks videos that disappeared', async () => {
    const s = await sessionWithClips([
      { uploadStatus: 'PUBLISHED', publishedAt: new Date(), youtubeVideoId: 'vidA' },
      { uploadStatus: 'PUBLISHED', publishedAt: new Date(), youtubeVideoId: 'vidGone' },
      { uploadStatus: 'PUBLISHED', publishedAt: new Date(), youtubeVideoId: 'mock123' },
    ]);
    const account = { uploadsAreMock: false, isConnected: async () => true, accessToken: async () => 'tok' } as unknown as YouTubeAccountService;
    const asked: string[][] = [];
    const res = await refreshVideoStats({
      account,
      fetchStats: async (ids) => {
        asked.push(ids);
        return [{ id: 'vidA', views: 1200, likes: 80, comments: 5, privacyStatus: 'public' }];
      },
    });
    expect(asked).toEqual([['vidA', 'vidGone']]); // mock uploads are skipped
    expect(res).toEqual({ updated: 1, missing: 1 });
    expect((await GeneratedClipModel.findById(s.clipIds[0]).lean())!.stats).toMatchObject({ views: 1200, likes: 80, privacyStatus: 'public' });
    expect((await GeneratedClipModel.findById(s.clipIds[1]).lean())!.stats).toMatchObject({ privacyStatus: 'deleted' });
    // Fresh stats are not fetched again within a few hours.
    expect(await refreshVideoStats({ account, fetchStats: async () => [] })).toEqual({ updated: 0, missing: 0 });
  });
});

describe('notifications', () => {
  it('sends messages, de-duplicates one-off alerts and never throws', async () => {
    const sent: string[] = [];
    const keys = new Set<string>();
    const redis = { set: async (k: string) => (keys.has(k) ? null : (keys.add(k), 'OK')) } as unknown as Redis;
    const n = new NotificationService({ notifier: { name: 't', send: async (t) => void sent.push(t) }, webOrigin: 'http://app', redis });
    await n.reviewReady('s1', 'Mock Gamer', 3);
    await n.youtubeReconnect('revoked');
    await n.youtubeReconnect('revoked again');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe('🎬 3 Shorts from Mock Gamer ready for review\nhttp://app/clips?session=s1');

    const broken: Notifier = { name: 'x', send: async () => { throw new Error('telegram down'); } };
    await expect(new NotificationService({ notifier: broken, webOrigin: 'http://app' }).uploadFailed('T', 'e')).resolves.toBeUndefined();
  });
});
