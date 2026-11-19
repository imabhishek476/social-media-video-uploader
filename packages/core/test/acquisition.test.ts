import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { LiveSessionModel, StreamerChannelModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { LocalObjectStorage, assertSafeKey } from '@shorts/integrations';
import { ProcessingStatus, SessionStatus, SourceMediaStatus } from '@shorts/shared-types';
import { AcquisitionService, LocalFolderProvider, SettingsService, probeMedia, sweepExpiredSources, validateMedia } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_test';

let root: string;
let incoming: string;
let storage: LocalObjectStorage;
let settings: SettingsService;
let service: AcquisitionService;

function makeVideo(file: string, seconds: number, opts: { audio?: boolean } = {}) {
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=10:duration=${seconds}`];
  if (opts.audio !== false) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (opts.audio !== false) args.push('-c:a', 'aac', '-shortest');
  execFileSync('ffmpeg', [...args, file]);
}

async function newSession() {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'x')}`, channelUrl: 'https://x', displayName: 'S' });
  return LiveSessionModel.create({
    streamerChannelId: ch._id,
    broadcastId: `bc${Math.random().toString(36).slice(2, 9)}`,
    status: SessionStatus.ENDED,
    processingStatus: ProcessingStatus.QUEUED,
    startedAt: new Date(Date.now() - 3600_000),
    endedAt: new Date(),
  });
}

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-acq-'));
  incoming = path.join(root, 'incoming');
  await fs.mkdir(incoming);
  storage = new LocalObjectStorage(path.join(root, 'objects'));
  settings = new SettingsService(parseConfig({ NODE_ENV: 'test' }));
  service = new AcquisitionService({ settings, storage, source: new LocalFolderProvider(incoming), tempDir: path.join(root, 'tmp') });
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

describe('probe and validation', () => {
  it('reads real media details and applies limits', async () => {
    const f = path.join(root, 'probe.mp4');
    makeVideo(f, 12);
    const info = await probeMedia(f);
    expect(info).toMatchObject({ width: 320, height: 180, videoCodec: 'h264', hasVideo: true, hasAudio: true });
    expect(info.durationSeconds).toBeGreaterThan(11);
    expect(validateMedia(info, { maxDurationMinutes: 60, maxFileSizeMb: 100 })).toBeNull();
    expect(validateMedia({ ...info, durationSeconds: 7200 }, { maxDurationMinutes: 60, maxFileSizeMb: 100 })).toMatch(/over the 60 min limit/);
    expect(validateMedia({ ...info, sizeBytes: 200 * 1024 * 1024 }, { maxDurationMinutes: 60, maxFileSizeMb: 100 })).toMatch(/over the 100 MB limit/);
    expect(validateMedia({ ...info, hasAudio: false }, { maxDurationMinutes: 60, maxFileSizeMb: 100 })).toMatch(/no audio/);
  });
});

describe('AcquisitionService', () => {
  it('stores a valid recording, records its details, removes the local copy, and is idempotent', async () => {
    const s = await newSession();
    const file = path.join(incoming, `${s.broadcastId}.mp4`);
    makeVideo(file, 15);

    expect(await service.acquire(String(s._id))).toBe('READY');
    const after = (await LiveSessionModel.findById(s._id).lean())!;
    expect(after).toMatchObject({ status: SessionStatus.SOURCE_READY, processingStatus: ProcessingStatus.QUEUED });
    expect(after.sourceMedia).toMatchObject({ status: SourceMediaStatus.READY, provider: 'local', width: 320, height: 180, hasAudio: true, videoCodec: 'h264' });
    expect(after.sourceMedia!.storageKey).toBe(`raw/${s._id}/source.mp4`);
    expect(await storage.exists(after.sourceMedia!.storageKey!)).toBe(true);
    await expect(fs.access(file)).rejects.toThrow();

    expect(await service.acquire(String(s._id))).toBe('ALREADY_READY');
  });

  it('finds a dashboard upload named after the session id', async () => {
    const s = await newSession();
    makeVideo(path.join(incoming, `${s._id}.mp4`), 12);
    expect(await service.acquire(String(s._id))).toBe('READY');
  });

  it('marks the session SOURCE_UNAVAILABLE with guidance when no recording exists', async () => {
    const s = await newSession();
    expect(await service.acquire(String(s._id))).toBe('UNAVAILABLE');
    const after = (await LiveSessionModel.findById(s._id).lean())!;
    expect(after).toMatchObject({ status: SessionStatus.SOURCE_UNAVAILABLE, processingStatus: ProcessingStatus.FAILED });
    expect(after.sourceMedia!.status).toBe(SourceMediaStatus.UNAVAILABLE);
    expect(after.lastError).toMatch(/Upload it on the session page/);
  });

  it('rejects corrupt files, silent videos and over-limit durations, and removes the bad file', async () => {
    const corrupt = await newSession();
    await fs.writeFile(path.join(incoming, `${corrupt.broadcastId}.mp4`), 'this is not a video');
    expect(await service.acquire(String(corrupt._id))).toBe('REJECTED');
    expect((await LiveSessionModel.findById(corrupt._id).lean())!.sourceMedia!.lastError).toMatch(/not readable media/);
    await expect(fs.access(path.join(incoming, `${corrupt.broadcastId}.mp4`))).rejects.toThrow();

    const silent = await newSession();
    makeVideo(path.join(incoming, `${silent.broadcastId}.mp4`), 12, { audio: false });
    expect(await service.acquire(String(silent._id))).toBe('REJECTED');
    expect((await LiveSessionModel.findById(silent._id).lean())!.lastError).toMatch(/no audio/);

    const long = await newSession();
    makeVideo(path.join(incoming, `${long.broadcastId}.mp4`), 70);
    await settings.update({ processing: { maxSourceDurationMinutes: 1 } }, String(new mongoose.Types.ObjectId()));
    expect(await service.acquire(String(long._id))).toBe('REJECTED');
    expect((await LiveSessionModel.findById(long._id).lean())!.lastError).toMatch(/over the 1 min limit/);
  });

  it('skips cancelled sessions', async () => {
    const s = await newSession();
    await LiveSessionModel.updateOne({ _id: s._id }, { status: SessionStatus.CANCELLED });
    expect(await service.acquire(String(s._id))).toBe('SKIPPED');
  });
});

describe('retention sweep', () => {
  it('deletes only sources older than the retention window', async () => {
    await settings.update({ retention: { sourceDays: 3 } }, String(new mongoose.Types.ObjectId()));
    const make = async (ageDays: number) => {
      const s = await newSession();
      const f = path.join(incoming, `${s.broadcastId}.mp4`);
      makeVideo(f, 11);
      await service.acquire(String(s._id));
      await LiveSessionModel.updateOne({ _id: s._id }, { 'sourceMedia.readyAt': new Date(Date.now() - ageDays * 86_400_000) });
      return s;
    };
    const old = await make(5);
    const fresh = await make(1);

    expect(await sweepExpiredSources({ settings, storage })).toEqual({ deleted: 1 });
    const o = (await LiveSessionModel.findById(old._id).lean())!;
    expect(o.sourceMedia).toMatchObject({ status: SourceMediaStatus.EXPIRED, storageKey: null });
    expect(await storage.exists(`raw/${old._id}/source.mp4`)).toBe(false);
    expect(await storage.exists(`raw/${fresh._id}/source.mp4`)).toBe(true);

    await settings.update({ retention: { sourceDays: 0 } }, String(new mongoose.Types.ObjectId()));
    expect(await sweepExpiredSources({ settings, storage }, new Date(Date.now() + 999 * 86_400_000))).toEqual({ deleted: 0 });
  });
});

describe('storage keys', () => {
  it('rejects keys that could escape the storage root', () => {
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', './a']) expect(() => assertSafeKey(bad)).toThrow();
    expect(() => assertSafeKey('raw/abc/source.mp4')).not.toThrow();
  });
});
