import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { LiveSessionModel, ProcessingJobModel, StreamerChannelModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { createMemoryQuotaTracker } from '@shorts/integrations';
import { QueueRegistry, createRedisConnection, type Redis } from '@shorts/queue';
import { JobType, LiveStatus, ProcessingStatus, QUEUE_NAMES, SessionStatus } from '@shorts/shared-types';
import { ChannelService, DomainError, LiveMonitorService, LiveSessionService, SettingsService } from '../src';
import { FakeProvider } from './fake-provider';

const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_core_test';
const REDIS_URL = process.env.TEST_REDIS_URL_CORE ?? 'redis://localhost:6379/14';

let redis: Redis;
let queues: QueueRegistry;
let provider: FakeProvider;
let channels: ChannelService;
let sessions: LiveSessionService;
let monitor: LiveMonitorService;

const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
  redis = createRedisConnection(REDIS_URL);
  queues = new QueueRegistry(redis);
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await queues.closeAll();
  redis.disconnect();
  await disconnectDatabase();
});

beforeEach(async () => {
  // Clear documents but keep collections/indexes (dropping per test exhausts
  // MongoDB file handles).
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  await redis.flushdb();
  provider = new FakeProvider();
  const settings = new SettingsService(parseConfig({ NODE_ENV: 'test' })); // 300s checks, 60s watch, 3 confirmations
  sessions = new LiveSessionService({ queues, settings, provider });
  monitor = new LiveMonitorService({ provider, quota: createMemoryQuotaTracker(), settings, sessions, dailyQuota: 10_000, random: () => 0.5 });
  channels = new ChannelService(provider);
});

async function registerStreamer(n: number) {
  const c = provider.addChannel(n);
  const { streamer } = await channels.register({ channel: c.handle!, monitoringEnabled: true, tags: [] });
  return { ...streamer, channelId: c.channelId };
}

const acquisitionJobs = () => ProcessingJobModel.find({ jobType: JobType.MEDIA_ACQUISITION }).lean();

describe('ChannelService', () => {
  it('registers by handle and rejects duplicates, bad input and unknown channels', async () => {
    const s = await registerStreamer(1);
    expect(s).toMatchObject({ displayName: 'Streamer 1', handle: '@streamer1', monitoringEnabled: true, channelUrl: 'https://www.youtube.com/@streamer1' });

    await expect(channels.register({ channel: '@streamer1', monitoringEnabled: true, tags: [] })).rejects.toMatchObject({ code: 'DUPLICATE_CHANNEL', httpStatus: 409 });
    await expect(channels.register({ channel: 'https://example.com/@x', monitoringEnabled: true, tags: [] })).rejects.toMatchObject({ code: 'INVALID_CHANNEL_INPUT', httpStatus: 400 });
    await expect(channels.register({ channel: '@nobody-here', monitoringEnabled: true, tags: [] })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND', httpStatus: 404 });
  });

  it('soft-deletes, hides from the list, and restores the same record on re-add', async () => {
    const s = await registerStreamer(1);
    await channels.remove(s.id);
    expect((await channels.list({ page: 1, pageSize: 25 })).total).toBe(0);
    await expect(channels.get(s.id)).rejects.toBeInstanceOf(DomainError);

    const again = await channels.register({ channel: '@streamer1', monitoringEnabled: true, tags: [] });
    expect(again.restored).toBe(true);
    expect(again.streamer.id).toBe(s.id);
  });

  it('supports at least 10 channels with search and filters', async () => {
    for (let i = 1; i <= 12; i++) await registerStreamer(i);
    await channels.setMonitoring((await channels.list({ page: 1, pageSize: 1, search: 'Streamer 3' })).items[0]!.id, false);
    expect((await channels.list({ page: 1, pageSize: 5 })).total).toBe(12);
    expect((await channels.list({ page: 1, pageSize: 50, monitoring: 'paused' })).items.map((s) => s.displayName)).toEqual(['Streamer 3']);
  });
});

describe('LiveMonitorService', () => {
  it('marks an idle channel OFFLINE and schedules the next check at the interval', async () => {
    const s = await registerStreamer(1);
    const now = at(new Date(), 1);
    const r = await monitor.tick(now);
    expect(r).toMatchObject({ checked: 1, live: 0, failed: 0 });
    const ch = await StreamerChannelModel.findById(s.id).lean();
    expect(ch!.liveStatus).toBe(LiveStatus.OFFLINE);
    expect(ch!.nextCheckAt!.getTime()).toBe(now.getTime() + 300_000);

    // Not due again yet → not re-checked.
    expect((await monitor.tick(at(now, 10))).checked).toBe(0);
  });

  it('creates exactly one session per broadcast across repeated checks', async () => {
    const s = await registerStreamer(1);
    provider.goLive(s.channelId, 'vid00000001');
    const t0 = at(new Date(), 1);

    expect(await monitor.tick(t0)).toMatchObject({ live: 1, newSessions: 1 });
    expect(await monitor.tick(at(t0, 400))).toMatchObject({ live: 1, newSessions: 0 });
    expect(await monitor.tick(at(t0, 800))).toMatchObject({ live: 1, newSessions: 0 });

    expect(await LiveSessionModel.countDocuments()).toBe(1);
    const ch = await StreamerChannelModel.findById(s.id).lean();
    expect(ch).toMatchObject({ liveStatus: LiveStatus.LIVE, currentLiveTitle: 'Live vid00000001', totalSessions: 1 });
  });

  it('batches one videos lookup for many channels and never double-checks under concurrent ticks', async () => {
    for (let i = 1; i <= 5; i++) await registerStreamer(i);
    const now = at(new Date(), 1);
    const [a, b] = await Promise.all([monitor.tick(now), monitor.tick(now)]);
    expect(a.checked + b.checked).toBe(5);
    expect(provider.calls.discovery).toBe(5);
  });

  it('backs off on failures, goes UNKNOWN after 3, and recovers', async () => {
    const s = await registerStreamer(1);
    provider.failDiscovery.add(s.channelId);
    let t = at(new Date(), 1);
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      await monitor.tick(t);
      const ch = await StreamerChannelModel.findById(s.id).lean();
      gaps.push(ch!.nextCheckAt!.getTime() - t.getTime());
      t = ch!.nextCheckAt!;
    }
    expect(gaps).toEqual([300_000, 600_000, 1_200_000]);
    let ch = await StreamerChannelModel.findById(s.id).lean();
    expect(ch).toMatchObject({ liveStatus: LiveStatus.UNKNOWN, consecutiveCheckFailures: 3 });
    expect(ch!.lastError).toMatch(/simulated outage/);

    provider.failDiscovery.clear();
    await monitor.tick(t);
    ch = await StreamerChannelModel.findById(s.id).lean();
    expect(ch).toMatchObject({ liveStatus: LiveStatus.OFFLINE, consecutiveCheckFailures: 0, lastError: null });
  });

  it('skips paused and removed channels', async () => {
    const a = await registerStreamer(1);
    const b = await registerStreamer(2);
    await channels.setMonitoring(a.id, false);
    await channels.remove(b.id);
    expect((await monitor.tick(at(new Date(), 1))).checked).toBe(0);
  });

  it('processes a stream that started and ended between checks, but not older VODs', async () => {
    const s = await registerStreamer(1);
    const registeredAt = new Date((await StreamerChannelModel.findById(s.id).lean())!.monitoringSince!);
    provider.goLive(s.channelId, 'oldstream01', at(registeredAt, -7200));
    provider.end('oldstream01', 'clean', at(registeredAt, -3600));
    provider.goLive(s.channelId, 'quickstrm01', at(registeredAt, 5));
    provider.end('quickstrm01', 'clean', at(registeredAt, 65));

    const r = await monitor.tick(at(registeredAt, 100));
    expect(r.newSessions).toBe(1);
    const all = await LiveSessionModel.find().lean();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ broadcastId: 'quickstrm01', status: SessionStatus.ENDED, endReason: 'MISSED_LIVE', durationSeconds: 60 });
    expect(await acquisitionJobs()).toHaveLength(1);
  });
});

describe('LiveSessionService.watchTick', () => {
  async function liveSession() {
    const s = await registerStreamer(1);
    provider.goLive(s.channelId, 'broadcast01');
    const t0 = at(new Date(), 1);
    await monitor.tick(t0);
    const session = await LiveSessionModel.findOne({ broadcastId: 'broadcast01' }).lean();
    return { streamer: s, session: session!, t0 };
  }

  it('keeps a live session live and resets confirmations', async () => {
    const { session, t0 } = await liveSession();
    await LiveSessionModel.updateOne({ _id: session._id }, { endConfirmationCount: 2 });
    expect(await sessions.watchTick(at(t0, 61))).toMatchObject({ checked: 1, stillLive: 1, ended: 0 });
    expect((await LiveSessionModel.findById(session._id).lean())!.endConfirmationCount).toBe(0);
  });

  it('never ends a stream because an API request failed', async () => {
    const { session, t0 } = await liveSession();
    provider.end('broadcast01', 'ambiguous');
    provider.failGetVideos = 5;
    for (let i = 1; i <= 5; i++) {
      const r = await sessions.watchTick(at(t0, 61 * i));
      expect(r.providerError).toMatch(/simulated API failure/);
    }
    const s = await LiveSessionModel.findById(session._id).lean();
    expect(s).toMatchObject({ status: SessionStatus.LIVE, endConfirmationCount: 0 });
    expect(s!.lastError).toMatch(/Watch check failed/);
  });

  it('requires N consecutive "not live" observations, and a live reading resets the count', async () => {
    const { session, t0, streamer } = await liveSession();
    provider.end('broadcast01', 'ambiguous');
    await sessions.watchTick(at(t0, 61));
    await sessions.watchTick(at(t0, 122));
    expect((await LiveSessionModel.findById(session._id).lean())!.endConfirmationCount).toBe(2);

    provider.goLive(streamer.channelId, 'broadcast01'); // reconnect
    await sessions.watchTick(at(t0, 183));
    expect((await LiveSessionModel.findById(session._id).lean())!.endConfirmationCount).toBe(0);

    provider.end('broadcast01', 'ambiguous');
    expect((await sessions.watchTick(at(t0, 244))).ended).toBe(0);
    expect((await sessions.watchTick(at(t0, 305))).ended).toBe(0);
    expect((await sessions.watchTick(at(t0, 366))).ended).toBe(1);
    const s = await LiveSessionModel.findById(session._id).lean();
    expect(s).toMatchObject({ status: SessionStatus.ENDED, endReason: 'NOT_LIVE_CONFIRMED', processingStatus: ProcessingStatus.QUEUED });
  });

  it('ends a vanished broadcast after N checks', async () => {
    const { session, t0 } = await liveSession();
    provider.end('broadcast01', 'vanish');
    for (let i = 1; i <= 3; i++) await sessions.watchTick(at(t0, 61 * i));
    expect((await LiveSessionModel.findById(session._id).lean())!.endReason).toBe('UNAVAILABLE_CONFIRMED');
  });

  it('ends immediately on a provider end time and enqueues processing exactly once', async () => {
    const { session, t0, streamer } = await liveSession();
    const endedAt = at(t0, 3600);
    provider.end('broadcast01', 'clean', endedAt);

    expect((await sessions.watchTick(at(t0, 61))).ended).toBe(1);
    // Duplicate signals: another watch, the monitor seeing the ended video, a direct end call.
    await sessions.watchTick(at(t0, 200));
    await monitor.tick(at(t0, 400));
    expect(await sessions.endSession(String(session._id), endedAt, 'PROVIDER_END_TIME')).toBe(false);

    const s = await LiveSessionModel.findById(session._id).lean();
    expect(s).toMatchObject({ status: SessionStatus.ENDED, endReason: 'PROVIDER_END_TIME', processingStatus: ProcessingStatus.QUEUED });
    expect(s!.endedAt!.getTime()).toBe(endedAt.getTime());
    expect(await acquisitionJobs()).toHaveLength(1);
    expect((await queues.get(QUEUE_NAMES[JobType.MEDIA_ACQUISITION]).getJobCounts('waiting')).waiting).toBe(1);

    const ch = await StreamerChannelModel.findById(streamer.id).lean();
    expect(ch).toMatchObject({ liveStatus: LiveStatus.OFFLINE, currentLiveSessionId: null });
    expect(String(ch!.lastLiveSessionId)).toBe(String(session._id));
  });
});

describe('LiveSessionService.reprocess and removal', () => {
  it('guards reprocessing and enqueues a fresh round when allowed', async () => {
    const s = await registerStreamer(1);
    provider.goLive(s.channelId, 'broadcast02');
    const t0 = at(new Date(), 1);
    await monitor.tick(t0);
    const session = (await LiveSessionModel.findOne().lean())!;
    const id = String(session._id);

    await expect(sessions.reprocess(id)).rejects.toMatchObject({ code: 'SESSION_STILL_LIVE' });
    provider.end('broadcast02', 'clean');
    await sessions.watchTick(at(t0, 61));
    await expect(sessions.reprocess(id)).rejects.toMatchObject({ code: 'ALREADY_QUEUED' });

    await LiveSessionModel.updateOne({ _id: id }, { processingStatus: ProcessingStatus.FAILED });
    const dto = await sessions.reprocess(id);
    expect(dto).toMatchObject({ reprocessCount: 1, processingStatus: ProcessingStatus.QUEUED });
    expect(await acquisitionJobs()).toHaveLength(2);
    await expect(sessions.reprocess('000000000000000000000000')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('cancels an in-progress session when its streamer is removed', async () => {
    const s = await registerStreamer(1);
    provider.goLive(s.channelId, 'broadcast03');
    await monitor.tick(at(new Date(), 1));
    await channels.remove(s.id);
    expect((await LiveSessionModel.findOne().lean())!.status).toBe(SessionStatus.CANCELLED);
    expect(await acquisitionJobs()).toHaveLength(0);
  });
});
