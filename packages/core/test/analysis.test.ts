import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { HighlightCandidateModel, LiveSessionModel, StreamerChannelModel, TranscriptModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { AiProviderError, LocalObjectStorage, buildTranscriptBlock, type HighlightAnalyzer, type RawHighlight } from '@shorts/integrations';
import { HeuristicHighlightAnalyzer, MockTranscriptionProvider } from '@shorts/integrations/testing';
import { UnrecoverableError } from '@shorts/queue';
import { CandidateStatus, ProcessingStatus, SessionStatus, SourceMediaStatus } from '@shorts/shared-types';
import { AnalysisService, CandidateService, SettingsService, extractAudioChunks, measureLoudness, mergeHighlights, normalizeHighlight } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_analysis_test';
const ADMIN = String(new mongoose.Types.ObjectId());

let root: string;
let video: string;
let storage: LocalObjectStorage;
let settings: SettingsService;

const raw = (over: Partial<RawHighlight>): RawHighlight => ({
  startSeconds: 0,
  endSeconds: 30,
  keyMomentSeconds: null,
  score: 70,
  breakdown: { hook: 50, emotion: 50, entertainment: 50, context: 50, payoff: 50, clarity: 50 },
  hook: '',
  reason: '',
  topic: null,
  ...over,
});

async function readySession(durationSeconds = 60) {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'x')}`, channelUrl: 'https://x', displayName: 'Tester' });
  const s = await LiveSessionModel.create({
    streamerChannelId: ch._id,
    broadcastId: `bc${Math.random().toString(36).slice(2, 9)}`,
    title: 'Test stream',
    status: SessionStatus.SOURCE_READY,
    processingStatus: ProcessingStatus.QUEUED,
    sourceMedia: { status: SourceMediaStatus.READY, storageKey: null, durationSeconds },
  });
  const key = `raw/${s._id}/source.mp4`;
  await storage.upload(key, video);
  await LiveSessionModel.updateOne({ _id: s._id }, { 'sourceMedia.storageKey': key });
  return String(s._id);
}

const service = (analyzer: HighlightAnalyzer = new HeuristicHighlightAnalyzer()) =>
  new AnalysisService({ settings, storage, transcription: new MockTranscriptionProvider(), analyzer, workDir: path.join(root, 'work') });

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-analysis-'));
  storage = new LocalObjectStorage(path.join(root, 'objects'));
  settings = new SettingsService(parseConfig({ NODE_ENV: 'test' }));
  // 60 s test video: quiet tone, with a loud burst at 30–40 s (a "reaction").
  video = path.join(root, 'stream.mp4');
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=60',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,30,40),0.8,0.01)*sin(2*PI*440*t)':d=60:s=16000",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
  ]);
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  await settings.update({ clips: { minDurationSeconds: 10, maxDurationSeconds: 20, defaultDurationSeconds: 15, maxClipsPerStream: 2, minHighlightScore: 40 } }, ADMIN);
});

describe('timestamp validation', () => {
  const bounds = { minSeconds: 30, maxSeconds: 60, sourceSeconds: 600 };

  it('rejects unusable ranges', () => {
    expect(normalizeHighlight(raw({ startSeconds: NaN }), bounds, [])).toBeNull();
    expect(normalizeHighlight(raw({ startSeconds: 50, endSeconds: 40 }), bounds, [])).toBeNull();
    expect(normalizeHighlight(raw({}), { ...bounds, sourceSeconds: 20 }, [])).toBeNull();
  });

  it('clamps to the source, extends short clips and trims long ones around the key moment', () => {
    expect(normalizeHighlight(raw({ startSeconds: 590, endSeconds: 700 }), bounds, [])).toMatchObject({ startSeconds: 570, endSeconds: 600 });
    expect(normalizeHighlight(raw({ startSeconds: 100, endSeconds: 110 }), bounds, [])).toMatchObject({ startSeconds: 90, endSeconds: 120 });
    const long = normalizeHighlight(raw({ startSeconds: 100, endSeconds: 300, keyMomentSeconds: 200 }), bounds, [])!;
    expect(long.endSeconds - long.startSeconds).toBe(60);
    expect(long.startSeconds).toBeLessThan(200);
    expect(long.endSeconds).toBeGreaterThan(200);
    expect(normalizeHighlight(raw({ score: 140 }), bounds, [])!.score).toBe(100);
  });

  it('snaps edges to sentence boundaries', () => {
    const segs = [
      { startSeconds: 98.5, endSeconds: 104, text: 'setup' },
      { startSeconds: 104, endSeconds: 141.2, text: 'payoff' },
    ];
    expect(normalizeHighlight(raw({ startSeconds: 100, endSeconds: 140 }), bounds, segs)).toMatchObject({ startSeconds: 98.3, endSeconds: 141.5 });
  });

  it('merges near-duplicates and keeps the stronger of conflicting overlaps', () => {
    const merged = mergeHighlights(
      [raw({ startSeconds: 0, endSeconds: 30, score: 80 }), raw({ startSeconds: 10, endSeconds: 40, score: 70 }), raw({ startSeconds: 100, endSeconds: 130, score: 60 })],
      60,
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ startSeconds: 0, endSeconds: 40, score: 80 });
    const conflict = mergeHighlights([raw({ startSeconds: 0, endSeconds: 50, score: 60 }), raw({ startSeconds: 40, endSeconds: 90, score: 90 })], 60);
    expect(conflict).toEqual([expect.objectContaining({ startSeconds: 40, score: 90 })]);
  });
});

describe('audio tools', () => {
  it('measures per-second loudness and finds the loud section', async () => {
    const loud = await measureLoudness(video);
    expect(loud.length).toBeGreaterThanOrEqual(59);
    expect(loud[35]! - loud[10]!).toBeGreaterThan(25);
  });

  it('splits audio into provider-sized pieces with correct offsets', async () => {
    const chunks = await extractAudioChunks(video, path.join(root, 'chunks'), 24 * 1024 * 1024, 25);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.offsetSeconds).toBe(0);
    expect(chunks[1]!.offsetSeconds).toBeCloseTo(chunks[0]!.durationSeconds, 1);
  });

  it('tags loud transcript lines for the LLM', () => {
    const loudness = Array.from({ length: 60 }, (_, i) => (i >= 30 && i < 40 ? -5 : -40));
    const block = buildTranscriptBlock({
      streamTitle: '',
      streamerName: '',
      windowStartSeconds: 0,
      windowEndSeconds: 60,
      segments: [
        { startSeconds: 5, endSeconds: 8, text: 'calm' },
        { startSeconds: 31, endSeconds: 34, text: 'NO WAY' },
      ],
      loudness,
      clip: { minSeconds: 10, maxSeconds: 20, targetSeconds: 15 },
      maxCandidates: 3,
    });
    expect(block).toBe('[5s | 0:05] calm\n[31s | 0:31] (LOUD +35 dB) NO WAY');
  });
});

describe('AnalysisService', () => {
  it('transcribes once, analyses, and selects the loud moment', async () => {
    const id = await readySession();
    const svc = service();
    expect(await svc.transcribe(id)).toBe('TRANSCRIBED');
    expect(await svc.transcribe(id)).toBe('CACHED');
    const t = (await TranscriptModel.findOne({ liveSessionId: id }).select('+loudness').lean())!;
    expect(t.segmentCount).toBeGreaterThan(5);
    expect(t.loudness.length).toBeGreaterThanOrEqual(59);

    const result = await svc.analyze(id, 0);
    expect(result).toMatchObject({ selected: expect.any(Number) });
    const selected = await HighlightCandidateModel.find({ liveSessionId: id, status: CandidateStatus.SELECTED }).sort({ score: -1 }).lean();
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(selected.length).toBeLessThanOrEqual(2);
    // The best clip covers the loud burst and respects the length limits.
    expect(selected[0]!.startSeconds).toBeLessThan(40);
    expect(selected[0]!.endSeconds).toBeGreaterThan(30);
    for (const c of selected) expect(c.endSeconds - c.startSeconds).toBeLessThanOrEqual(20);

    const session = (await LiveSessionModel.findById(id).lean())!;
    expect(session).toMatchObject({ status: SessionStatus.HIGHLIGHTS_READY, processingStatus: ProcessingStatus.COMPLETED, processingStage: null });
    expect(session.highlightCount).toBeGreaterThanOrEqual(1);
    // Work files are cleaned up.
    expect(await fs.readdir(path.join(root, 'work'))).toEqual([]);
  });

  it('keeps clips a person picked when re-analysing, and replaces the rest', async () => {
    const id = await readySession();
    const svc = service();
    await svc.transcribe(id);
    await svc.analyze(id, 0);
    const candidates = new CandidateService(settings);
    const [first] = await candidates.listForSession(id);
    const edited = await candidates.update(first!.id, { startSeconds: 28, endSeconds: 42 });
    expect(edited).toMatchObject({ userAdjusted: true, durationSeconds: 14 });

    await svc.analyze(id, 1);
    const after = await candidates.listForSession(id);
    expect(after.find((c) => c.id === edited.id)).toMatchObject({ startSeconds: 28, endSeconds: 42 });
    // No new clip overlaps the kept one.
    for (const c of after.filter((c) => c.id !== edited.id)) expect(c.endSeconds <= 28 || c.startSeconds >= 42).toBe(true);
  });

  it('validates Clip Studio edits', async () => {
    const id = await readySession();
    const svc = service();
    await svc.transcribe(id);
    await svc.analyze(id, 0);
    const candidates = new CandidateService(settings);
    const [c] = await candidates.listForSession(id);
    await expect(candidates.update(c!.id, { startSeconds: 10, endSeconds: 61 })).rejects.toThrow(/past the end/);
    await expect(candidates.update(c!.id, { startSeconds: 0, endSeconds: 59 })).rejects.toThrow(/maximum is 20s/);
    const discarded = await candidates.update(c!.id, { status: 'DISCARDED' });
    expect(discarded).toMatchObject({ status: 'DISCARDED', discardReason: 'Discarded in Clip Studio' });
  });

  it('turns permanent provider errors into non-retryable job failures', async () => {
    const id = await readySession();
    const failing: HighlightAnalyzer = {
      name: 'failing',
      analyze: async () => {
        throw new AiProviderError('AUTH', 'bad key', false);
      },
    };
    const svc = service(failing);
    await svc.transcribe(id);
    await expect(svc.analyze(id, 0)).rejects.toBeInstanceOf(UnrecoverableError);

    const flaky: HighlightAnalyzer = {
      name: 'flaky',
      analyze: async () => {
        throw new AiProviderError('RATE_LIMITED', 'slow down', true);
      },
    };
    await expect(service(flaky).analyze(id, 0)).rejects.toBeInstanceOf(AiProviderError);
  });

  it('refuses to transcribe without a stored source', async () => {
    const id = await readySession();
    await LiveSessionModel.updateOne({ _id: id }, { 'sourceMedia.status': SourceMediaStatus.EXPIRED, 'sourceMedia.storageKey': null });
    await expect(service().transcribe(id)).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
