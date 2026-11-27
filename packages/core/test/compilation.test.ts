import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { CompilationModel, GeneratedClipModel, HighlightCandidateModel, IntegrationCredentialModel, LiveSessionModel, StreamerChannelModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { LocalObjectStorage } from '@shorts/integrations';
import { MockYouTubeUploader } from '@shorts/integrations/testing';
import { CompilationService, SettingsService, chapterStamp, type YouTubeAccountService } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_compilation_test';
const ADMIN = String(new mongoose.Types.ObjectId());
let root: string;
let storage: LocalObjectStorage;
let settings: SettingsService;
let sample: string;
const account = { isConnected: async () => true, accessToken: async () => 'tok' } as unknown as YouTubeAccountService;

async function publishedShort(title: string, views: number) {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'c')}`, channelUrl: 'https://x', displayName: 'IShowSpeed' });
  const s = await LiveSessionModel.create({ streamerChannelId: ch._id, broadcastId: `b${Math.random().toString(36).slice(2, 9)}`, title: 'GTA night' });
  const cand = await HighlightCandidateModel.create({ liveSessionId: s._id, startSeconds: 0, endSeconds: 3, score: 80, status: 'SELECTED' });
  const key = `clips/${s._id}/x/v1.mp4`;
  await fs.mkdir(path.dirname(path.join(root, 'objects', key)), { recursive: true });
  await fs.copyFile(sample, path.join(root, 'objects', key));
  return GeneratedClipModel.create({
    liveSessionId: s._id, streamerChannelId: ch._id, highlightCandidateId: cand._id, startSeconds: 0, endSeconds: 3, durationSeconds: 3,
    renderStatus: 'RENDERED', storageKey: key, title, uploadStatus: 'PUBLISHED', youtubeVideoId: `yt${views}`, publishedAt: new Date(Date.now() - 86_400_000),
    stats: { views, likes: 0, comments: 0, privacyStatus: 'public', fetchedAt: new Date() },
  });
}

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-compilation-'));
  storage = new LocalObjectStorage(path.join(root, 'objects'));
  settings = new SettingsService(parseConfig({ NODE_ENV: 'test' }));
  // A tiny vertical "Short" with sound.
  sample = path.join(root, 'sample.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=270x480:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', sample]);
}, 60_000);
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  await IntegrationCredentialModel.create({ provider: 'youtube', accountId: 'UC', encryptedRefreshToken: 'x', status: 'ACTIVE' });
  await settings.update({ publishing: { weeklyCompilation: 'ON', compilationMinShorts: 3, focusLanguage: '' } }, ADMIN);
});

describe('weekly compilation', () => {
  it('formats chapter stamps', () => {
    expect(chapterStamp(0)).toBe('0:00');
    expect(chapterStamp(65.4)).toBe('1:05');
    expect(chapterStamp(3725)).toBe('1:02:05');
  });

  it('skips a week without enough public Shorts', async () => {
    await publishedShort('Only one', 10);
    const svc = new CompilationService({ settings, storage, account, uploader: new MockYouTubeUploader(), workDir: path.join(root, 'work') });
    expect(await svc.build()).toBe('skipped');
    expect((await CompilationModel.findOne().lean())!.lastError).toMatch(/Only 1 public Shorts/);
  });

  it('joins the most-watched Shorts into a 16:9 video with chapters and uploads it once', async () => {
    await publishedShort('Low views', 5);
    await publishedShort('Top moment', 900);
    await publishedShort('Middle moment', 50);
    const uploader = new MockYouTubeUploader();
    const svc = new CompilationService({ settings, storage, account, uploader, workDir: path.join(root, 'work') });
    expect(await svc.build()).toBe('published');
    expect(uploader.uploads).toHaveLength(1);
    const m = uploader.uploads[0]!.metadata;
    expect(m.title).toMatch(/IShowSpeed Best Moments This Week/);
    expect(m.description).toMatch(/0:00 Top moment\n0:0[23] Middle moment\n0:0[56] Low views/);
    const row = (await CompilationModel.findOne().lean())!;
    expect(row).toMatchObject({ status: 'PUBLISHED', clipIds: expect.any(Array) });
    expect(row.durationSeconds).toBeGreaterThanOrEqual(8);
    expect(await svc.build()).toBe('already published');
  }, 120_000);
});
