import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveMonitorService, LiveSessionService, SettingsService } from '@shorts/core';
import { MockYouTubeProvider, createMemoryQuotaTracker } from '@shorts/integrations';
import type { QueueRegistry } from '@shorts/queue';
import type { AppConfig } from '@shorts/config';
import { ADMIN, VIEWER, setupTestApp } from './helpers';

let app: Express;
let teardown: () => Promise<void>;
let monitor: LiveMonitorService;
let sessions: LiveSessionService;
const provider = new MockYouTubeProvider();

beforeAll(async () => {
  const ctx = await setupTestApp(provider);
  app = ctx.app;
  teardown = ctx.teardown;
  const settings = new SettingsService(ctx.config as AppConfig);
  sessions = new LiveSessionService({ queues: ctx.queues as QueueRegistry, settings, provider });
  monitor = new LiveMonitorService({ provider, quota: createMemoryQuotaTracker(), settings, sessions, dailyQuota: 10_000 });
});
afterAll(async () => {
  await teardown();
});

async function agentFor(creds = ADMIN) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send(creds).expect(200);
  return agent;
}

describe('streamer management API', () => {
  let streamerId: string;
  let channelId: string;

  it('registers a channel from a URL and rejects duplicates and bad input', async () => {
    const admin = await agentFor();
    const res = await admin.post('/api/v1/streamers').send({ channel: 'https://www.youtube.com/@mock-gamer/live', tags: ['fps'] }).expect(201);
    expect(res.body).toMatchObject({ displayName: 'Mock Gamer', handle: '@mock-gamer', monitoringEnabled: true, tags: ['fps'] });
    streamerId = res.body.id;
    channelId = res.body.channelId;

    const dup = await admin.post('/api/v1/streamers').send({ channel: channelId }).expect(409);
    expect(dup.body.error).toMatchObject({ code: 'DUPLICATE_CHANNEL', details: { streamerId } });

    const bad = await admin.post('/api/v1/streamers').send({ channel: 'https://vimeo.com/someone' }).expect(400);
    expect(bad.body.error.code).toBe('INVALID_CHANNEL_INPUT');
    await admin.post('/api/v1/streamers').send({ channel: '@x', unknownField: 1 }).expect(400);
  });

  it('lets viewers read but not write', async () => {
    const viewer = await agentFor(VIEWER);
    const list = await viewer.get('/api/v1/streamers').expect(200);
    expect(list.body.total).toBe(1);
    await viewer.post('/api/v1/streamers').send({ channel: '@mock-irl' }).expect(403);
    await viewer.delete(`/api/v1/streamers/${streamerId}`).expect(403);
  });

  it('updates details and per-channel preferences with validation', async () => {
    const admin = await agentFor();
    const res = await admin
      .patch(`/api/v1/streamers/${streamerId}`)
      .send({ displayName: 'Gamer (Main)', preferences: { maxClipsPerStream: 3, language: 'hi' } })
      .expect(200);
    expect(res.body.displayName).toBe('Gamer (Main)');
    expect(res.body.preferences).toMatchObject({ maxClipsPerStream: 3, language: 'hi', minHighlightScore: null });
    await admin.patch(`/api/v1/streamers/${streamerId}`).send({ preferences: { minClipDurationSeconds: 90, maxClipDurationSeconds: 30 } }).expect(400);
  });

  it('pauses and resumes monitoring', async () => {
    const admin = await agentFor();
    expect((await admin.patch(`/api/v1/streamers/${streamerId}/monitoring`).send({ enabled: false }).expect(200)).body.monitoringEnabled).toBe(false);
    expect((await admin.post(`/api/v1/streamers/${streamerId}/check`).expect(409)).body.error.code).toBe('MONITORING_PAUSED');
    expect((await admin.patch(`/api/v1/streamers/${streamerId}/monitoring`).send({ enabled: true }).expect(200)).body.monitoringEnabled).toBe(true);
    await admin.post(`/api/v1/streamers/${streamerId}/check`).expect(200);
  });

  it('runs the full live lifecycle through the mock provider', async () => {
    const admin = await agentFor();
    await admin.post(`/api/v1/dev/mock-youtube/channels/${channelId}/go-live`).send({ title: 'Ranked grind' }).expect(201);

    const t0 = new Date(Date.now() + 1000);
    expect(await monitor.tick(t0)).toMatchObject({ live: 1, newSessions: 1 });

    const streamer = await admin.get(`/api/v1/streamers/${streamerId}`).expect(200);
    expect(streamer.body).toMatchObject({ liveStatus: 'LIVE', currentLiveTitle: 'Ranked grind', totalSessions: 1 });

    const live = await admin.get('/api/v1/live-sessions').query({ status: 'LIVE' }).expect(200);
    expect(live.body.total).toBe(1);
    const session = live.body.items[0];
    expect(session).toMatchObject({ title: 'Ranked grind', streamer: { id: streamerId, displayName: 'Gamer (Main)' } });
    expect(session.videoUrl).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
    expect((await admin.post(`/api/v1/live-sessions/${session.id}/reprocess`).expect(409)).body.error.code).toBe('SESSION_STILL_LIVE');

    const dash = await admin.get('/api/v1/dashboard/summary').expect(200);
    expect(dash.body.counts).toMatchObject({ streamers: 1, liveStreamers: 1 });

    await admin.post(`/api/v1/dev/mock-youtube/channels/${channelId}/end-live`).send({ mode: 'clean' }).expect(200);
    await admin.post(`/api/v1/dev/mock-youtube/channels/${channelId}/end-live`).send({}).expect(409);
    expect((await sessions.watchTick(new Date(t0.getTime() + 61_000))).ended).toBe(1);

    const ended = await admin.get(`/api/v1/live-sessions/${session.id}`).expect(200);
    expect(ended.body).toMatchObject({ status: 'ENDED', processingStatus: 'QUEUED', endReason: 'PROVIDER_END_TIME' });
    expect(ended.body.durationSeconds).toBeGreaterThanOrEqual(0);

    const jobs = await admin.get('/api/v1/jobs').query({ jobType: 'MEDIA_ACQUISITION' }).expect(200);
    expect(jobs.body.total).toBe(1);
    expect(jobs.body.items[0]).toMatchObject({ status: 'PENDING', entityType: 'LiveSession', entityId: session.id });
    expect((await admin.post(`/api/v1/live-sessions/${session.id}/reprocess`).expect(409)).body.error.code).toBe('ALREADY_QUEUED');

    const after = await admin.get(`/api/v1/streamers/${streamerId}`).expect(200);
    expect(after.body).toMatchObject({ liveStatus: 'OFFLINE', lastLiveSession: { id: session.id, status: 'ENDED' } });

    const filtered = await admin.get('/api/v1/live-sessions').query({ streamerId }).expect(200);
    expect(filtered.body.total).toBe(1);
    await admin.get('/api/v1/live-sessions').query({ streamerId: 'nope' }).expect(400);
  });

  it('reports the metadata provider in system status', async () => {
    const admin = await agentFor();
    const res = await admin.get('/api/v1/system/status').expect(200);
    expect(res.body.youtube).toMatchObject({ provider: 'mock', liveDetection: 'rss', dailyQuota: 10_000 });
  });

  it('removes a streamer (soft delete) but keeps its sessions', async () => {
    const admin = await agentFor();
    await admin.delete(`/api/v1/streamers/${streamerId}`).expect(204);
    await admin.get(`/api/v1/streamers/${streamerId}`).expect(404);
    expect((await admin.get('/api/v1/streamers').expect(200)).body.total).toBe(0);
    expect((await admin.get('/api/v1/live-sessions').expect(200)).body.total).toBe(1);
  });
});
