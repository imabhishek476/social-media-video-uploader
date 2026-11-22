import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChatActivityModel, GeneratedClipModel, HighlightCandidateModel, LiveSessionModel, ProcessingJobModel, StreamerChannelModel,
  TranscriptChunkModel, TranscriptModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes,
} from '@shorts/database';
import { LocalObjectStorage } from '@shorts/integrations';
import { StreamerPurgeService } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI_PURGE ?? 'mongodb://localhost:27017/ai_shorts_core_purge_test';
let root: string;
beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'purge-'));
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
  await fs.rm(root, { recursive: true, force: true });
});

async function streamerWithData(n: number, storage: LocalObjectStorage) {
  const ch = await StreamerChannelModel.create({ channelId: `UC${String(n).padStart(22, '0')}`, channelUrl: 'https://x', displayName: `S${n}` });
  const s = await LiveSessionModel.create({ streamerChannelId: ch._id, broadcastId: `vid0000000${n}`, sourceMedia: { storageKey: `raw/X/source.mp4` } });
  const sid = String(s._id);
  await LiveSessionModel.updateOne({ _id: sid }, { 'sourceMedia.storageKey': `raw/${sid}/source.mp4` });
  const t = await TranscriptModel.create({ liveSessionId: sid, provider: 'p', segmentCount: 0, chunkCount: 1 });
  await TranscriptChunkModel.create({ transcriptId: t._id, liveSessionId: sid, index: 0, startSeconds: 0, endSeconds: 300, segments: [] });
  const cand = await HighlightCandidateModel.create({ liveSessionId: sid, startSeconds: 0, endSeconds: 30, score: 70 });
  const clip = await GeneratedClipModel.create({ liveSessionId: sid, streamerChannelId: ch._id, highlightCandidateId: cand._id, startSeconds: 0, endSeconds: 30, durationSeconds: 30, storageKey: `clips/${sid}/c/v1.mp4` });
  await ChatActivityModel.create({ liveSessionId: sid, anchorAt: new Date() });
  await ProcessingJobModel.create({ idempotencyKey: `k${n}`, jobType: 'CLIP_RENDER', queueName: 'clip-render', entityType: 'LiveSession', entityId: s._id });
  for (const key of [`raw/${sid}/source.mp4`, `clips/${sid}/c/v1.mp4`]) {
    await fs.mkdir(path.dirname(path.join(root, 'objects', key)), { recursive: true });
    await fs.writeFile(path.join(root, 'objects', key), 'x');
  }
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  await fs.writeFile(path.join(root, 'tmp', `ytdlp-${sid}.mp4`), 'x');
  return { id: String(ch._id), sid, clipId: String(clip._id) };
}

describe('StreamerPurgeService', () => {
  it('deletes the streamer, all its data and files, and leaves other streamers alone', async () => {
    const storage = new LocalObjectStorage(path.join(root, 'objects'));
    const a = await streamerWithData(1, storage);
    const b = await streamerWithData(2, storage);
    const purge = new StreamerPurgeService({ storages: [storage], tempDir: path.join(root, 'tmp') });
    const summary = await purge.purge(a.id);
    expect(summary).toMatchObject({ sessions: 1, clips: 1 });

    expect(await StreamerChannelModel.exists({ _id: a.id })).toBeNull();
    for (const M of [LiveSessionModel, TranscriptModel, TranscriptChunkModel, HighlightCandidateModel, GeneratedClipModel, ChatActivityModel]) {
      expect(await (M as typeof LiveSessionModel).countDocuments({ $or: [{ liveSessionId: a.sid }, { _id: a.sid }] })).toBe(0);
    }
    expect(await ProcessingJobModel.countDocuments({ entityId: new mongoose.Types.ObjectId(a.sid) })).toBe(0);
    await expect(fs.stat(path.join(root, 'objects', 'raw', a.sid))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'objects', 'clips', a.sid))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'tmp', `ytdlp-${a.sid}.mp4`))).rejects.toThrow();

    // The other streamer is untouched.
    expect(await LiveSessionModel.countDocuments({ _id: b.sid })).toBe(1);
    expect(await GeneratedClipModel.countDocuments({ _id: b.clipId })).toBe(1);
    await fs.stat(path.join(root, 'objects', 'raw', b.sid, 'source.mp4'));
    await expect(purge.purge(a.id)).rejects.toThrow(/not found/i);
  });

  it('deletes one session and remembers its broadcast so the monitor skips it', async () => {
    const storage = new LocalObjectStorage(path.join(root, 'objects'));
    const c = await streamerWithData(3, storage);
    await new StreamerPurgeService({ storages: [storage], tempDir: path.join(root, 'tmp') }).purgeSession(c.sid);
    expect(await LiveSessionModel.exists({ _id: c.sid })).toBeNull();
    expect(await GeneratedClipModel.exists({ _id: c.clipId })).toBeNull();
    await expect(fs.stat(path.join(root, 'objects', 'raw', c.sid))).rejects.toThrow();
    const ch = await StreamerChannelModel.findById(c.id).lean();
    expect(ch?.ignoredBroadcastIds).toEqual(['vid00000003']);
  });
});

describe('withChannelBranding', () => {
  it('puts the footer above a merged, de-duplicated hashtag line', async () => {
    const { withChannelBranding } = await import('../src');
    const d = 'Big moment.\n\n🎮 From X: https://y\n\n#Shorts #GTA6';
    expect(withChannelBranding(d, 'Clutch Clips\\nSubscribe', 'gaming, #gta6, stream-highlights')).toBe(
      'Big moment.\n\n🎮 From X: https://y\n\nClutch Clips\nSubscribe\n\n#Shorts #GTA6 #gaming #streamhighlights',
    );
    expect(withChannelBranding('Plain', '', '')).toBe('Plain');
  });
});
