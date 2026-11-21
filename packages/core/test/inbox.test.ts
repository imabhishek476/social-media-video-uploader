import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { LiveSessionModel, StreamerChannelModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { LocalObjectStorage } from '@shorts/integrations';
import type { QueueRegistry } from '@shorts/queue';
import { AcquisitionService, InboxWatcher, LiveSessionService, SessionImportService, SettingsService, StorageInboxProvider, parseVideoInput } from '../src';
import { FakeProvider } from './fake-provider';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_inbox_test';

let root: string;
let storage: LocalObjectStorage;
let settings: SettingsService;
let provider: FakeProvider;
let sessions: LiveSessionService;
let importer: SessionImportService;
const enqueued: string[] = [];
const queues = { enqueue: async (_q: string, _n: string, _d: unknown, key: string) => void enqueued.push(key) } as unknown as QueueRegistry;

async function registered(n: number) {
  const c = provider.addChannel(n);
  await StreamerChannelModel.create({ channelId: c.channelId, channelUrl: 'https://x', displayName: c.title });
  return c.channelId;
}

async function dropInInbox(name: string, seconds = 11) {
  const file = path.join(root, 'objects', 'incoming', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mp4', file]);
}

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-inbox-'));
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
  await fs.rm(path.join(root, 'objects', 'incoming'), { recursive: true, force: true });
  provider = new FakeProvider();
  sessions = new LiveSessionService({ queues, settings, provider });
  importer = new SessionImportService({ provider, sessions });
});

describe('parseVideoInput', () => {
  it('accepts every common YouTube link form', () => {
    for (const s of [
      'dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/live/dQw4w9WgXcQ?feature=share',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(parseVideoInput(s)).toBe('dQw4w9WgXcQ');
    }
    for (const bad of ['', 'hello', 'https://vimeo.com/123', 'https://www.youtube.com/@channel', 'https://youtube.com/watch?v=short']) expect(parseVideoInput(bad)).toBeNull();
  });
});

describe('SessionImportService', () => {
  it('imports an ended stream of a registered streamer and queues processing', async () => {
    const ch = await registered(1);
    provider.goLive(ch, 'vidEnded123', new Date(Date.now() - 3600_000));
    provider.end('vidEnded123', 'clean');
    const { session, created } = await importer.importVideo('https://youtu.be/vidEnded123');
    expect(created).toBe(true);
    expect(session).toMatchObject({ status: 'ENDED', processingStatus: 'QUEUED', endReason: 'IMPORTED', broadcastId: 'vidEnded123' });
    expect(session.durationSeconds).toBeGreaterThan(3500);
    expect(enqueued).toHaveLength(1);
    // Importing again returns the same session.
    expect(await importer.importVideo('vidEnded123')).toMatchObject({ created: false, session: { id: session.id } });
    expect(enqueued).toHaveLength(1);
  });

  it('tracks a stream that is still live instead of ending it', async () => {
    const ch = await registered(2);
    provider.goLive(ch, 'vidStillLiv');
    const { session } = await importer.importVideo('https://www.youtube.com/live/vidStillLiv');
    expect(session.status).toBe('LIVE');
    expect(enqueued).toHaveLength(0);
  });

  it('explains what is wrong', async () => {
    await expect(importer.importVideo('not a url')).rejects.toMatchObject({ code: 'INVALID_VIDEO_URL', httpStatus: 400 });
    await expect(importer.importVideo('unknown1234')).rejects.toMatchObject({ code: 'VIDEO_NOT_FOUND', httpStatus: 404 });
    provider.goLive('UCunregistered000000000', 'otherChan01');
    provider.end('otherChan01', 'clean');
    await expect(importer.importVideo('otherChan01')).rejects.toMatchObject({ code: 'CHANNEL_NOT_REGISTERED', httpStatus: 409 });
  });
});

describe('storage inbox', () => {
  it('acquires a recording from incoming/<videoId>.mp4 and removes it from the inbox', async () => {
    const ch = await registered(3);
    provider.goLive(ch, 'vidInbox001');
    provider.end('vidInbox001', 'clean');
    const { session } = await importer.importVideo('vidInbox001');
    await dropInInbox('vidInbox001.mp4');

    const acquisition = new AcquisitionService({ settings, storage, source: new StorageInboxProvider(storage, path.join(root, 'tmp')), tempDir: path.join(root, 'tmp') });
    expect(await acquisition.acquire(session.id)).toBe('READY');
    expect(await storage.exists(`raw/${session.id}/source.mp4`)).toBe(true);
    expect(await storage.exists('incoming/vidInbox001.mp4')).toBe(false);
    expect((await LiveSessionModel.findById(session.id).lean())!.sourceMedia).toMatchObject({ status: 'READY', provider: 'local-inbox' });
  }, 60_000);

  it('watcher reprocesses waiting sessions, imports files named after a video id, and backs off on unmatched files', async () => {
    const ch = await registered(4);
    // 1) A session that already gave up waiting for its recording.
    provider.goLive(ch, 'vidWaiting1');
    provider.end('vidWaiting1', 'clean');
    const { session: waiting } = await importer.importVideo('vidWaiting1');
    await LiveSessionModel.updateOne({ _id: waiting.id }, { status: 'SOURCE_UNAVAILABLE', processingStatus: 'FAILED' });
    // 2) A missed live nobody registered.
    provider.goLive(ch, 'vidNewDrop1');
    provider.end('vidNewDrop1', 'clean');
    await dropInInbox('vidWaiting1.mp4', 2);
    await dropInInbox('vidNewDrop1.mp4', 2);
    await dropInInbox('my-recording.mp4', 2);
    await fs.writeFile(path.join(root, 'objects', 'incoming', 'notes.txt'), 'ignored');

    const watcher = new InboxWatcher({ storage, storageDir: path.join(root, 'local'), sessions, importer });
    const res = await watcher.tick();
    expect(res.files).toBe(3);
    expect(res.reprocessed).toEqual([waiting.id]);
    expect(res.imported).toHaveLength(1);
    expect(res.skipped).toEqual([{ file: 'my-recording.mp4', reason: expect.stringMatching(/neither a session id nor a YouTube video id/) }]);
    expect((await LiveSessionModel.findOne({ broadcastId: 'vidNewDrop1' }).lean())!.endReason).toBe('IMPORTED');

    // Next tick: queued sessions are left to acquisition; the unmatched file is not retried yet.
    const again = await watcher.tick();
    expect(again).toMatchObject({ reprocessed: [], imported: [], skipped: [] });
  }, 60_000);
});
