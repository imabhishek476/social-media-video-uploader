import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import {
  GeneratedClipModel,
  HighlightCandidateModel,
  LiveSessionModel,
  StreamerChannelModel,
  TranscriptChunkModel,
  TranscriptModel,
  connectDatabase,
  disconnectDatabase,
  mongoose,
  syncIndexes,
} from '@shorts/database';
import { LocalObjectStorage } from '@shorts/integrations';
import { UnrecoverableError } from '@shorts/queue';
import { ProcessingStatus, SessionStatus, SourceMediaStatus } from '@shorts/shared-types';
import { CandidateService, ClipService, RenderService, SettingsService, assColor, buildAssCaptions, probeMedia, renderShort, wordsFromSegments } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_render_test';
const ADMIN = String(new mongoose.Types.ObjectId());

let root: string;
let video: string;
let storage: LocalObjectStorage;
let settings: SettingsService;

const style = { fontFamily: 'DejaVu Sans', fontSize: 72, primaryColor: '#FFFFFF', highlightColor: '#FFD400', position: 'MIDDLE' as const };

async function sessionWithClips() {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'r')}`, channelUrl: 'https://x', displayName: 'R' });
  const s = await LiveSessionModel.create({
    streamerChannelId: ch._id,
    broadcastId: `b${Math.random().toString(36).slice(2, 9)}`,
    status: SessionStatus.HIGHLIGHTS_READY,
    processingStatus: ProcessingStatus.COMPLETED,
    sourceMedia: { status: SourceMediaStatus.READY, storageKey: null, durationSeconds: 20 },
  });
  const key = `raw/${s._id}/source.mp4`;
  await storage.upload(key, video);
  await LiveSessionModel.updateOne({ _id: s._id }, { 'sourceMedia.storageKey': key });
  const t = await TranscriptModel.create({ liveSessionId: s._id, provider: 'mock', segmentCount: 2, chunkCount: 1 });
  await TranscriptChunkModel.create({
    transcriptId: t._id,
    liveSessionId: s._id,
    index: 0,
    startSeconds: 0,
    endSeconds: 300,
    segments: [
      { startSeconds: 1, endSeconds: 4, text: 'okay chat watch this' },
      { startSeconds: 5, endSeconds: 8, text: 'NO WAY, that just happened!' },
    ],
  });
  const [a, b] = await HighlightCandidateModel.create([
    { liveSessionId: s._id, startSeconds: 0, endSeconds: 6, keyMomentSeconds: 5, score: 90, status: 'SELECTED' },
    { liveSessionId: s._id, startSeconds: 10, endSeconds: 14, score: 70, status: 'SELECTED' },
    { liveSessionId: s._id, startSeconds: 15, endSeconds: 19, score: 50, status: 'CANDIDATE' },
  ]);
  return { id: String(s._id), a: String(a!._id), b: String(b!._id) };
}

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-render-'));
  storage = new LocalObjectStorage(path.join(root, 'objects'));
  settings = new SettingsService(parseConfig({ NODE_ENV: 'test' }));
  video = path.join(root, 'source.mp4');
  // 16:9 source with audio.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
}, 60_000);
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  await settings.update({ subtitles: { fontFamily: 'DejaVu Sans' }, clips: { reframingMode: 'CENTER_CROP' } }, ADMIN);
});

describe('captions', () => {
  it('converts colours to ASS order', () => {
    expect(assColor('#FFD400')).toBe('&H0000D4FF');
  });

  it('spreads words over a segment and clips them to the range', () => {
    const words = wordsFromSegments([{ startSeconds: 10, endSeconds: 12, text: 'a bb ccc' }], 10.5, 20);
    expect(words.map((w) => w.text)).toEqual(['bb', 'ccc']);
    expect(words[0]!.start).toBe(0);
    expect(words.at(-1)!.end).toBeCloseTo(1.5, 5);
  });

  it('builds word-highlighted caption events and strips override syntax', () => {
    const ass = buildAssCaptions([{ startSeconds: 0, endSeconds: 2, text: 'hello {world}' }], 0, 5, style);
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('Style: Caption,DejaVu Sans,72,&H00FFFFFF,&H0000D4FF');
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue'));
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('{\\c&H0000D4FF}HELLO{\\c&H00FFFFFF} WORLD');
    expect(events[1]).toContain('HELLO {\\c&H0000D4FF}WORLD');
    expect(ass).not.toContain('{world}');
  });
});

describe('renderShort', () => {
  for (const mode of ['CENTER_CROP', 'BLUR_FIT'] as const) {
    it(`renders a 1080x1920 Short with audio (${mode})`, async () => {
      const ass = path.join(root, `${mode}.ass`);
      await fs.writeFile(ass, buildAssCaptions([{ startSeconds: 2, endSeconds: 4, text: 'no way that happened' }], 2, 6, style));
      const out = path.join(root, `${mode}.mp4`);
      const thumb = path.join(root, `${mode}.jpg`);
      const res = await renderShort({ sourcePath: video, outPath: out, thumbnailPath: thumb, captionsPath: ass, startSeconds: 2, endSeconds: 6, keyMomentSeconds: 3, mode });
      const info = await probeMedia(out);
      expect(info).toMatchObject({ width: 1080, height: 1920, hasAudio: true, videoCodec: 'h264' });
      expect(info.durationSeconds).toBeGreaterThan(3.8);
      expect(info.durationSeconds).toBeLessThan(4.3);
      expect(res.sizeBytes).toBeGreaterThan(1000);
      expect((await fs.stat(thumb)).size).toBeGreaterThan(1000);
    }, 60_000);
  }
});

describe('RenderService', () => {
  const service = () => new RenderService({ settings, storage, workDir: path.join(root, 'work') });

  it('renders selected highlights once, re-renders after a trim, and replaces the old version', async () => {
    const { id, a } = await sessionWithClips();
    expect(await service().renderSession(id)).toEqual({ rendered: 2, skipped: 0, failed: 0 });
    const clips = new ClipService(storage);
    const list = await clips.listForSession(id);
    expect(list).toHaveLength(2);
    expect(list.every((c) => c.renderStatus === 'RENDERED' && c.width === 1080 && c.height === 1920 && c.renderVersion === 1)).toBe(true);
    const first = (await GeneratedClipModel.findOne({ highlightCandidateId: a }).lean())!;
    expect(await storage.exists(first.storageKey!)).toBe(true);
    expect(await storage.exists(first.thumbnailKey!)).toBe(true);
    expect((await LiveSessionModel.findById(id).lean())!).toMatchObject({ clipCount: 2, processingStatus: ProcessingStatus.COMPLETED, processingStage: null });

    // Nothing changed → nothing to do.
    expect(await service().renderSession(id)).toEqual({ rendered: 0, skipped: 2, failed: 0 });

    // Trim one → version 2 replaces version 1 (files too).
    await new CandidateService(settings).update(a, { startSeconds: 1, endSeconds: 6 });
    expect(await service().renderSession(id)).toEqual({ rendered: 1, skipped: 1, failed: 0 });
    const versions = await GeneratedClipModel.find({ highlightCandidateId: a }).lean();
    expect(versions.map((v) => v.renderVersion)).toEqual([2]);
    expect(await storage.exists(first.storageKey!)).toBe(false);
    expect(versions[0]).toMatchObject({ startSeconds: 1, endSeconds: 6, durationSeconds: 5 });
  }, 120_000);

  it('never claims the same clip twice when two jobs run at once', async () => {
    const { id } = await sessionWithClips();
    const [x, y] = await Promise.all([service().renderSession(id), service().renderSession(id)]);
    const total = (r: typeof x) => (r === 'SKIPPED' ? 0 : r.rendered);
    expect(total(x) + total(y)).toBe(2);
    expect(await GeneratedClipModel.countDocuments({ liveSessionId: id })).toBe(2);
  }, 120_000);

  it('fails clearly when the source has expired', async () => {
    const { id } = await sessionWithClips();
    await LiveSessionModel.updateOne({ _id: id }, { 'sourceMedia.status': SourceMediaStatus.EXPIRED, 'sourceMedia.storageKey': null });
    await expect(service().renderSession(id)).rejects.toBeInstanceOf(UnrecoverableError);
    const clips = await GeneratedClipModel.find({ liveSessionId: id }).lean();
    expect(clips.every((c) => c.renderStatus === 'RENDER_FAILED' && /no longer stored/.test(c.lastError ?? ''))).toBe(true);
  });
});

describe('forced re-render', () => {
  it('creates a new version for up-to-date clips and removes the old files', async () => {
    const { id, a } = await sessionWithClips();
    const svc = new RenderService({ settings, storage, workDir: path.join(root, 'work') });
    await svc.renderSession(id);
    const v1 = (await GeneratedClipModel.findOne({ highlightCandidateId: a }).lean())!;
    expect(await svc.renderSession(id, undefined, { force: true })).toEqual({ rendered: 2, skipped: 0, failed: 0 });
    const now = await GeneratedClipModel.find({ highlightCandidateId: a }).lean();
    expect(now.map((c) => c.renderVersion)).toEqual([2]);
    expect(await storage.exists(v1.storageKey!)).toBe(false);
  }, 120_000);
});
