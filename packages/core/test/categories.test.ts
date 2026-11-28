import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@shorts/config';
import { CategoryPresetModel, GeneratedClipModel, IntegrationCredentialModel, LiveSessionModel, StreamerChannelModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { CategoryService, SettingsService, detectCategory } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_categories_test';
let settings: SettingsService;
const svc = () => new CategoryService({ settings });

async function session(title: string, streamer: { category?: string | null; game?: string | null } = {}) {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'p')}`, channelUrl: 'https://x', displayName: 'S', category: streamer.category ?? null, preferences: { game: streamer.game ?? null } });
  return LiveSessionModel.create({ streamerChannelId: ch._id, broadcastId: `b${Math.random().toString(36).slice(2, 9)}`, title });
}

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  settings = new SettingsService(parseConfig({ NODE_ENV: 'test' }));
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});
beforeEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

describe('detectCategory', () => {
  it('uses the streamer category, then the game, then title words', () => {
    expect(detectCategory({ streamerCategory: 'Podcast', title: 'GTA 6' })).toBe('PODCAST');
    expect(detectCategory({ streamerCategory: 'Gaming stuff' })).toBe('GAMING');
    expect(detectCategory({ title: '🔴EXPLORING VICE CITY - GTA 6 STREAM' })).toBe('GAMING');
    expect(detectCategory({ title: 'IRL in Tokyo with chat' })).toBe('IRL');
    expect(detectCategory({ title: 'Podcast ep 12 with a guest' })).toBe('PODCAST');
    expect(detectCategory({ title: 'Watching the IPL final' })).toBe('SPORTS');
    expect(detectCategory({ title: 'random stuff', streamerGame: 'BGMI' })).toBe('GAMING');
    expect(detectCategory({ title: 'random stuff' })).toBe('OTHER');
  });
});

describe('CategoryService', () => {
  it('detects and stores the session category once, and a manual choice wins', async () => {
    const s = await session('Late night IRL stream');
    expect(await svc().categoryOf(String(s._id))).toBe('IRL');
    expect((await LiveSessionModel.findById(s._id).lean())).toMatchObject({ category: 'IRL', categorySource: 'detected' });
    await svc().setSessionCategory(String(s._id), 'COMEDY');
    expect((await svc().presetFor(String(s._id))).category).toBe('COMEDY');
    await expect(svc().setSessionCategory(String(s._id), 'NOPE')).rejects.toThrow(/Unknown category/);
  });

  it('starts from default presets and saves edits', async () => {
    const podcast = await svc().get('PODCAST');
    expect(podcast).toMatchObject({ captionStyle: 'CLEAN', defaultDurationSeconds: 35, playlist: 'ON' });
    const out = await svc().update('PODCAST', { defaultDurationSeconds: 40, hashtags: '  ', playlist: 'OFF' });
    expect(out).toMatchObject({ defaultDurationSeconds: 40, hashtags: null, playlist: 'OFF', captionStyle: 'CLEAN' });
    await expect(svc().update('PODCAST', { minDurationSeconds: 60, maxDurationSeconds: 30 })).rejects.toThrow(/Shortest/);
    await expect(svc().update('PODCAST', { maxDurationSeconds: 999 })).rejects.toThrow(/5–180/);
    const s = await session('Podcast ep 3');
    expect(await svc().presetFor(String(s._id))).toMatchObject({ category: 'PODCAST', defaultDurationSeconds: 40, hashtags: null });
  });

  it('creates the category playlist once and adds each Short to it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url).replace(/\?.*/, ''));
      return new Response(JSON.stringify({ id: 'PL123' }), { status: 200 });
    });
    await IntegrationCredentialModel.create({ provider: 'youtube', accountId: 'UC1', accountTitle: 'Jumbo Surfer', encryptedRefreshToken: 'x', status: 'ACTIVE' });
    const s = await session('GTA 6 chaos');
    const mk = () => GeneratedClipModel.create({ liveSessionId: s._id, streamerChannelId: s.streamerChannelId, highlightCandidateId: new mongoose.Types.ObjectId(), startSeconds: 0, endSeconds: 20, durationSeconds: 20, youtubeVideoId: `v${Math.random()}`, uploadStatus: 'PUBLISHED' });
    const a = await mk();
    const b = await mk();
    const token = async () => 't';
    expect(await svc().addToPlaylist(String(a._id), token)).toBe('added');
    expect(await svc().addToPlaylist(String(b._id), token)).toBe('added');
    expect(await svc().addToPlaylist(String(b._id), token)).toBe('skipped');
    expect(calls.filter((u) => u.endsWith('/playlists'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/playlistItems'))).toHaveLength(2);
    expect(await CategoryPresetModel.findById('GAMING').lean()).toMatchObject({ playlistId: 'PL123', captionStyle: 'STREAMER' });
    // Stats group published Shorts by category.
    await GeneratedClipModel.updateMany({}, { $set: { stats: { views: 50, likes: 2 } } });
    expect(await svc().stats()).toEqual([expect.objectContaining({ category: 'GAMING', shorts: 2, views: 100 })]);
  });

  it('never fails the upload when the playlist call fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":{"message":"quota"}}', { status: 403 }));
    const s = await session('GTA 6');
    const c = await GeneratedClipModel.create({ liveSessionId: s._id, streamerChannelId: s.streamerChannelId, highlightCandidateId: new mongoose.Types.ObjectId(), startSeconds: 0, endSeconds: 20, durationSeconds: 20, youtubeVideoId: 'v1' });
    expect(await svc().addToPlaylist(String(c._id), async () => 't')).toBe('failed');
  });
});
