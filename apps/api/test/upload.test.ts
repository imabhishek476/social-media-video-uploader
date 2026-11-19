import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveSessionModel, StreamerChannelModel } from '@shorts/database';
import { ProcessingStatus, SessionStatus } from '@shorts/shared-types';
import { ADMIN, VIEWER, setupTestApp } from './helpers';

let app: Express;
let teardown: () => Promise<void>;
let storageDir: string;

beforeAll(async () => {
  const ctx = await setupTestApp();
  app = ctx.app;
  teardown = ctx.teardown;
  storageDir = ctx.config.worker.storageDir;
});
afterAll(async () => {
  await teardown();
  await fs.rm(storageDir, { recursive: true, force: true });
});

async function session(status: string) {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'y')}`, channelUrl: 'https://x', displayName: 'Up' });
  return LiveSessionModel.create({
    streamerChannelId: ch._id,
    broadcastId: `b${Math.random().toString(36).slice(2, 9)}`,
    status,
    processingStatus: status === SessionStatus.SOURCE_UNAVAILABLE ? ProcessingStatus.FAILED : ProcessingStatus.NOT_STARTED,
    startedAt: new Date(),
  });
}

describe('POST /live-sessions/:id/source', () => {
  it('stores the file in the incoming folder and queues acquisition', async () => {
    const s = await session(SessionStatus.SOURCE_UNAVAILABLE);
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send(ADMIN).expect(200);

    const res = await agent.post(`/api/v1/live-sessions/${s._id}/source`).set('X-Upload-Filename', encodeURIComponent('My Stream.mkv')).set('Content-Type', 'video/x-matroska').send(Buffer.from('fake-video-bytes')).expect(202);
    expect(res.body).toMatchObject({ processingStatus: 'QUEUED', status: 'ENDED' });
    expect(await fs.readFile(path.join(storageDir, 'incoming', `${s._id}.mkv`), 'utf8')).toBe('fake-video-bytes');
    const jobs = await agent.get('/api/v1/jobs').query({ jobType: 'MEDIA_ACQUISITION' }).expect(200);
    expect(jobs.body.items[0]).toMatchObject({ entityId: String(s._id), status: 'PENDING' });
  });

  it('rejects bad types, live sessions, viewers and uploads without the header (CSRF guard)', async () => {
    const ended = await session(SessionStatus.SOURCE_UNAVAILABLE);
    const live = await session(SessionStatus.LIVE);
    const admin = request.agent(app);
    await admin.post('/api/v1/auth/login').send(ADMIN).expect(200);

    const bad = await admin.post(`/api/v1/live-sessions/${ended._id}/source`).set('X-Upload-Filename', 'notes.txt').set('Content-Type', 'text/plain').send('hello').expect(415);
    expect(bad.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    const liveRes = await admin.post(`/api/v1/live-sessions/${live._id}/source`).set('X-Upload-Filename', 'a.mp4').set('Content-Type', 'video/mp4').send('x').expect(409);
    expect(liveRes.body.error.code).toBe('SESSION_STILL_LIVE');
    await admin.post(`/api/v1/live-sessions/${ended._id}/source`).set('Content-Type', 'video/mp4').send('x').expect(415);

    const viewer = request.agent(app);
    await viewer.post('/api/v1/auth/login').send(VIEWER).expect(200);
    await viewer.post(`/api/v1/live-sessions/${ended._id}/source`).set('X-Upload-Filename', 'a.mp4').set('Content-Type', 'video/mp4').send('x').expect(403);
  });
});
