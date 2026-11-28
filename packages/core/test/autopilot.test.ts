import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { AutopilotEventModel, GeneratedClipModel, LiveSessionModel, StreamerChannelModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { AutopilotService, SettingsService, overlapShare, qualityGate } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_autopilot_test';
const ADMIN = String(new mongoose.Types.ObjectId());
let settings: SettingsService;
const sent: string[] = [];

const base = { score: 88, durationSeconds: 28, title: 'He made the jump', minScore: 75, minDurationSeconds: 15, maxDurationSeconds: 45, duplicateOverlap: 0, languageMismatch: null };

async function session(autopilot: string | null = null) {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'p')}`, channelUrl: 'https://x', displayName: 'Mock', preferences: { autopilot } });
  const s = await LiveSessionModel.create({ streamerChannelId: ch._id, broadcastId: `b${Math.random().toString(36).slice(2, 9)}`, title: 'GTA' });
  return { ch, s };
}
const clip = (s: { _id: unknown }, ch: { _id: unknown }, o: Record<string, unknown>) =>
  GeneratedClipModel.create({ liveSessionId: s._id, streamerChannelId: ch._id, highlightCandidateId: new mongoose.Types.ObjectId(), startSeconds: 0, endSeconds: 28, durationSeconds: 28, renderStatus: 'RENDERED', title: 'A good one', highlightScore: 90, ...o });

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
  sent.length = 0;
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  await settings.update({ publishing: { mode: 'AUTO_PUBLISH', autopilotMinScore: 75 } }, ADMIN);
});

const service = () => new AutopilotService({ settings, notify: { send: async (t) => void sent.push(t) }, webOrigin: 'http://app' });

describe('quality gate', () => {
  it('passes a good Short and lists every reason to hold one', () => {
    expect(qualityGate(base)).toEqual([]);
    expect(qualityGate({ ...base, score: 61 })).toEqual(['score 61 < 75']);
    expect(qualityGate({ ...base, durationSeconds: 70 })[0]).toMatch(/too long/);
    expect(qualityGate({ ...base, durationSeconds: 48 })).toEqual([]); // cold open slack
    expect(qualityGate({ ...base, duplicateOverlap: 0.8 })[0]).toMatch(/same moment/);
    expect(qualityGate({ ...base, languageMismatch: 'hi' })[0]).toMatch(/language/);
    expect(qualityGate({ ...base, title: 'This is SHIT bro' })[0]).toMatch(/limit ads/);
    expect(qualityGate({ ...base, title: 'Shitake mushrooms' })).toEqual([]);
    expect(qualityGate({ ...base, score: 10, title: '' })).toHaveLength(2);
  });

  it('measures overlap against the shorter clip', () => {
    expect(overlapShare({ startSeconds: 0, endSeconds: 30 }, { startSeconds: 20, endSeconds: 30 })).toBe(1);
    expect(overlapShare({ startSeconds: 0, endSeconds: 30 }, { startSeconds: 30, endSeconds: 60 })).toBe(0);
  });
});

describe('AutopilotService', () => {
  it('approves Shorts that pass, holds the rest once, and logs why', async () => {
    const { ch, s } = await session();
    const good = await clip(s, ch, {});
    const low = await clip(s, ch, { highlightScore: 50, startSeconds: 100, endSeconds: 128 });
    const approved: string[] = [];
    const approve = async (id: string) => void approved.push(id);
    expect(await service().run(String(s._id), approve)).toEqual({ published: 1, held: 1 });
    expect(approved).toEqual([String(good._id)]);
    const events = await AutopilotEventModel.find().sort({ kind: 1 }).lean();
    expect(events.map((e) => [e.kind, e.reasons])).toEqual([['HELD', ['score 50 < 75']], ['PUBLISHED', ['score 90 ≥ 75']]]);
    expect(sent.some((t) => t.includes('Autopilot is publishing') && t.includes('http://app/autopilot'))).toBe(true);
    // A held Short is never re-decided automatically.
    await service().run(String(s._id), approve);
    expect(await AutopilotEventModel.countDocuments({ clipId: low._id })).toBe(1);
  });

  it('respects the per-streamer switch and the pause', async () => {
    await settings.update({ publishing: { mode: 'MANUAL_APPROVAL' } }, ADMIN);
    const on = await session('ON');
    const off = await session(null);
    expect(await service().activeFor(String(on.s._id))).toBe(true);
    expect(await service().activeFor(String(off.s._id))).toBe(false);
    await service().pause('test');
    expect(await service().activeFor(String(on.s._id))).toBe(false);
    expect((await service().status()).paused).toBe(true);
    await service().resume('me');
    expect(await service().activeFor(String(on.s._id))).toBe(true);
  });

  it('pauses itself after 3 failed auto uploads, or at once on a reconnect error', async () => {
    const { ch, s } = await session();
    const c = await clip(s, ch, { approvalStatus: 'AUTO_APPROVED' });
    const svc = service();
    await svc.uploadFailed(String(c._id), 'quota');
    await svc.uploadFailed(String(c._id), 'quota');
    expect((await svc.status()).paused).toBe(false);
    await svc.uploadSucceeded();
    await svc.uploadFailed(String(c._id), 'quota');
    await svc.uploadFailed(String(c._id), 'quota');
    expect((await svc.status()).paused).toBe(false);
    await svc.uploadFailed(String(c._id), 'quota');
    expect((await svc.status())).toMatchObject({ paused: true, pausedReason: expect.stringMatching(/3 uploads failed/) });
    await svc.resume('me');
    await svc.uploadFailed(String(c._id), 'Please reconnect the channel');
    expect((await svc.status()).pausedReason).toMatch(/YouTube connection/);
    expect(sent.filter((t) => t.startsWith('⏸'))).toHaveLength(2);
  });
});
