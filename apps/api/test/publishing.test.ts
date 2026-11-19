import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeneratedClipModel, HighlightCandidateModel, LiveSessionModel, StreamerChannelModel } from '@shorts/database';
import { ADMIN, VIEWER, setupTestApp } from './helpers';

let app: Express;
let teardown: () => Promise<void>;

beforeAll(async () => {
  const ctx = await setupTestApp();
  app = ctx.app;
  teardown = ctx.teardown;
});
afterAll(() => teardown());

async function clip(over: Record<string, unknown> = {}) {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'q')}`, channelUrl: 'https://x', displayName: 'Pub' });
  const s = await LiveSessionModel.create({ streamerChannelId: ch._id, broadcastId: `b${Math.random().toString(36).slice(2, 9)}` });
  const c = await HighlightCandidateModel.create({ liveSessionId: s._id, startSeconds: 0, endSeconds: 30, score: 80, hook: 'Wild jump', status: 'SELECTED' });
  const g = await GeneratedClipModel.create({ liveSessionId: s._id, streamerChannelId: ch._id, highlightCandidateId: c._id, startSeconds: 0, endSeconds: 30, durationSeconds: 30, renderStatus: 'RENDERED', storageKey: 'clips/x.mp4', ...over });
  return String(g._id);
}

describe('Publishing endpoints', () => {
  it('reports simulated uploads in settings when no OAuth client is configured', async () => {
    const admin = request.agent(app);
    await admin.post('/api/v1/auth/login').send(ADMIN).expect(200);
    const s = await admin.get('/api/v1/settings').expect(200);
    expect(s.body.youtube).toMatchObject({ uploadMode: 'mock', oauthConfigured: false, connected: false });
    const connect = await admin.get('/api/v1/integrations/youtube/connect').expect(400);
    expect(connect.body.error.code).toBe('YOUTUBE_NOT_CONFIGURED');
  });

  it('edits metadata, regenerates it, approves (queues the upload) and blocks viewers', async () => {
    const id = await clip();
    const admin = request.agent(app);
    await admin.post('/api/v1/auth/login').send(ADMIN).expect(200);

    const bad = await admin.patch(`/api/v1/clips/${id}`).send({ title: 'no <tags>' }).expect(400);
    expect(bad.body.error.message).toMatch(/< or >/);
    const noTitle = await admin.post(`/api/v1/clips/${id}/approve`).send({}).expect(409);
    expect(noTitle.body.error.code).toBe('METADATA_MISSING');

    const gen = await admin.post(`/api/v1/clips/${id}/metadata`).send({}).expect(200);
    expect(gen.body).toMatchObject({ title: 'Wild jump', metadataEditedByUser: false });
    expect(gen.body.description).toContain('#Shorts');

    const edited = await admin.patch(`/api/v1/clips/${id}`).send({ title: 'Edited title', tags: ['gta', 'jump'] }).expect(200);
    expect(edited.body).toMatchObject({ title: 'Edited title', tags: ['gta', 'jump'], metadataEditedByUser: true });

    const approved = await admin.post(`/api/v1/clips/${id}/approve`).send({}).expect(202);
    expect(approved.body).toMatchObject({ approvalStatus: 'APPROVED', uploadStatus: 'QUEUED' });
    const jobs = await admin.get('/api/v1/jobs').query({ jobType: 'YOUTUBE_UPLOAD' }).expect(200);
    expect(jobs.body.items[0]).toMatchObject({ entityId: id, status: 'PENDING' });
    await admin.post(`/api/v1/clips/${id}/approve`).send({}).expect(409);

    const viewer = request.agent(app);
    await viewer.post('/api/v1/auth/login').send(VIEWER).expect(200);
    await viewer.patch(`/api/v1/clips/${id}`).send({ title: 'x' }).expect(403);
    await viewer.post(`/api/v1/clips/${id}/approve`).send({}).expect(403);
  });

  it('rejects a clip', async () => {
    const id = await clip({ title: 'T' });
    const admin = request.agent(app);
    await admin.post('/api/v1/auth/login').send(ADMIN).expect(200);
    const res = await admin.post(`/api/v1/clips/${id}/reject`).send({}).expect(200);
    expect(res.body.approvalStatus).toBe('REJECTED');
  });

  it('OAuth callback is public and rejects unknown state with a redirect back to Settings', async () => {
    const res = await request(app).get('/api/v1/integrations/youtube/callback').query({ code: 'c', state: 'nope' }).expect(303);
    expect(res.headers.location).toMatch(/^http:\/\/localhost:5173\/settings\?youtube_error=/);
    const denied = await request(app).get('/api/v1/integrations/youtube/callback').query({ error: 'access_denied' }).expect(303);
    expect(new URL(denied.headers.location!).searchParams.get('youtube_error')).toBe('Access was not granted.');
  });
});
