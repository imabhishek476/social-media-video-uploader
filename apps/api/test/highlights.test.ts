import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeneratedClipModel, HighlightCandidateModel, LiveSessionModel, StreamerChannelModel, TranscriptChunkModel, TranscriptModel } from '@shorts/database';
import { ProcessingStatus, SessionStatus, SourceMediaStatus } from '@shorts/shared-types';
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

async function analysedSession() {
  const ch = await StreamerChannelModel.create({ channelId: `UC${Math.random().toString(36).slice(2).padEnd(22, 'h')}`, channelUrl: 'https://x', displayName: 'Hi' });
  const s = await LiveSessionModel.create({
    streamerChannelId: ch._id,
    broadcastId: `b${Math.random().toString(36).slice(2, 9)}`,
    status: SessionStatus.HIGHLIGHTS_READY,
    processingStatus: ProcessingStatus.COMPLETED,
    sourceMedia: { status: SourceMediaStatus.READY, storageKey: null, durationSeconds: 300 },
  });
  const key = `raw/${s._id}/source.mp4`;
  await fs.mkdir(path.join(storageDir, 'objects', 'raw', String(s._id)), { recursive: true });
  await fs.writeFile(path.join(storageDir, 'objects', key), Buffer.alloc(2000, 7));
  await LiveSessionModel.updateOne({ _id: s._id }, { 'sourceMedia.storageKey': key });

  const t = await TranscriptModel.create({ liveSessionId: s._id, provider: 'mock', segmentCount: 3, chunkCount: 1, durationSeconds: 300 });
  await TranscriptChunkModel.create({
    transcriptId: t._id,
    liveSessionId: s._id,
    index: 0,
    startSeconds: 0,
    endSeconds: 300,
    segments: [
      { startSeconds: 1, endSeconds: 4, text: 'hello' },
      { startSeconds: 100, endSeconds: 104, text: 'no way' },
      { startSeconds: 250, endSeconds: 255, text: 'bye' },
    ],
  });
  const [hi, lo] = await HighlightCandidateModel.create([
    { liveSessionId: s._id, startSeconds: 90, endSeconds: 130, score: 88, status: 'SELECTED', reason: 'reaction' },
    { liveSessionId: s._id, startSeconds: 200, endSeconds: 240, score: 55, status: 'CANDIDATE' },
  ]);
  return { id: String(s._id), hi: String(hi!._id), lo: String(lo!._id) };
}

describe('Clip Studio endpoints', () => {
  it('lists highlights by score, serves the transcript window and a preview URL', async () => {
    const { id, hi } = await analysedSession();
    const viewer = request.agent(app);
    await viewer.post('/api/v1/auth/login').send(VIEWER).expect(200);

    const list = await viewer.get(`/api/v1/live-sessions/${id}/highlights`).expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)[0]).toBe(hi);
    expect(list.body.items[0]).toMatchObject({ score: 88, durationSeconds: 40, status: 'SELECTED', userAdjusted: false });

    const t = await viewer.get(`/api/v1/live-sessions/${id}/transcript`).query({ from: 50, to: 200 }).expect(200);
    expect(t.body.segments).toEqual([{ startSeconds: 100, endSeconds: 104, text: 'no way' }]);

    const preview = await viewer.get(`/api/v1/live-sessions/${id}/source/preview`).expect(200);
    expect(preview.body).toEqual({ url: `/api/v1/live-sessions/${id}/source/file`, expiresAt: null });
    const file = await viewer.get(preview.body.url).set('Range', 'bytes=0-99').expect(206);
    expect(file.headers['content-range']).toBe('bytes 0-99/2000');

    await viewer.get('/api/v1/live-sessions/000000000000000000000000/transcript').expect(404);
  });

  it('lets admins select, discard and trim; viewers cannot', async () => {
    const { id, lo } = await analysedSession();
    const admin = request.agent(app);
    await admin.post('/api/v1/auth/login').send(ADMIN).expect(200);

    const sel = await admin.patch(`/api/v1/highlights/${lo}`).send({ status: 'SELECTED' }).expect(200);
    expect(sel.body).toMatchObject({ status: 'SELECTED', userAdjusted: true });
    const trim = await admin.patch(`/api/v1/highlights/${lo}`).send({ startSeconds: 205.04, endSeconds: 235 }).expect(200);
    expect(trim.body).toMatchObject({ startSeconds: 205, endSeconds: 235, durationSeconds: 30 });
    const tooLong = await admin.patch(`/api/v1/highlights/${lo}`).send({ startSeconds: 100, endSeconds: 190 }).expect(400);
    expect(tooLong.body.error.message).toMatch(/maximum/);
    await admin.patch(`/api/v1/highlights/${lo}`).send({ startSeconds: 50, endSeconds: 40 }).expect(400);
    await admin.patch(`/api/v1/highlights/${lo}`).send({ score: 100 }).expect(400);

    await admin.patch(`/api/v1/highlights/${lo}`).send({ status: 'DISCARDED' }).expect(200);
    const s = await admin.get(`/api/v1/live-sessions/${id}`).expect(200);
    expect(s.body.highlightCount).toBe(1);

    const viewer = request.agent(app);
    await viewer.post('/api/v1/auth/login').send(VIEWER).expect(200);
    await viewer.patch(`/api/v1/highlights/${lo}`).send({ status: 'SELECTED' }).expect(403);
  });

  it('reprocesses an analysed session (re-analysis reuses the transcript)', async () => {
    const { id } = await analysedSession();
    const admin = request.agent(app);
    await admin.post('/api/v1/auth/login').send(ADMIN).expect(200);
    const res = await admin.post(`/api/v1/live-sessions/${id}/reprocess`).expect(202);
    expect(res.body).toMatchObject({ processingStatus: 'QUEUED', reprocessCount: 1 });
  });
});

describe('Rendered Shorts endpoints', () => {
  it('queues a render, lists clips and serves media for rendered ones', async () => {
    const { id, hi, lo } = await analysedSession();
    const admin = request.agent(app);
    await admin.post('/api/v1/auth/login').send(ADMIN).expect(200);
    expect((await admin.get(`/api/v1/live-sessions/${id}/clips`).expect(200)).body.items).toEqual([]);

    await admin.post(`/api/v1/live-sessions/${id}/render`).send({}).expect(202);
    const jobs = await admin.get('/api/v1/jobs').query({ jobType: 'CLIP_RENDER' }).expect(200);
    expect(jobs.body.items[0]).toMatchObject({ entityId: id, status: 'PENDING' });

    const session = await LiveSessionModel.findById(id).lean();
    const key = `clips/${id}/x/v2.mp4`;
    await fs.mkdir(path.join(storageDir, 'objects', 'clips', id, 'x'), { recursive: true });
    await fs.writeFile(path.join(storageDir, 'objects', key), Buffer.alloc(500, 1));
    const base = { liveSessionId: id, streamerChannelId: session!.streamerChannelId, startSeconds: 90, endSeconds: 130, durationSeconds: 40 };
    await GeneratedClipModel.create([
      { ...base, highlightCandidateId: hi, renderVersion: 1, renderStatus: 'RENDERED', storageKey: 'clips/old.mp4' },
      { ...base, highlightCandidateId: hi, renderVersion: 2, renderStatus: 'RENDERED', storageKey: key },
      { ...base, highlightCandidateId: lo, renderVersion: 1, renderStatus: 'RENDER_FAILED', lastError: 'boom' },
    ]);
    const list = (await admin.get(`/api/v1/live-sessions/${id}/clips`).expect(200)).body.items;
    expect(list).toHaveLength(2); // latest version per highlight only
    const rendered = list.find((c: { renderVersion: number }) => c.renderVersion === 2);
    const failed = list.find((c: { renderStatus: string }) => c.renderStatus === 'RENDER_FAILED');
    expect(failed.lastError).toBe('boom');

    const media = (await admin.get(`/api/v1/clips/${rendered.id}/media`).expect(200)).body;
    expect(media).toMatchObject({ videoUrl: `/api/v1/clips/${rendered.id}/file/video`, thumbnailUrl: null });
    await admin.get(media.videoUrl).expect(200);
    await admin.get(`/api/v1/clips/${failed.id}/media`).expect(409);

    const viewer = request.agent(app);
    await viewer.post('/api/v1/auth/login').send(VIEWER).expect(200);
    await viewer.post(`/api/v1/live-sessions/${id}/render`).send({}).expect(403);
    await viewer.get(`/api/v1/clips/${rendered.id}/media`).expect(200);
  });
});
