import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel, ProcessingJobModel, UserModel } from '@shorts/database';
import { ALL_QUEUE_NAMES, JobStatus, JobType } from '@shorts/shared-types';
import { ADMIN, VIEWER, setupTestApp } from './helpers';

let app: Express;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ app, teardown } = await setupTestApp());
});
afterAll(async () => {
  await teardown();
});

async function loggedIn(creds = ADMIN) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send(creds).expect(200);
  return agent;
}

describe('health and readiness', () => {
  it('GET /health is public', async () => {
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /ready reports MongoDB and Redis', async () => {
    const res = await request(app).get('/api/v1/ready').expect(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.mongo.ok).toBe(true);
    expect(res.body.checks.redis.ok).toBe(true);
  });

  it('propagates a well-formed X-Request-Id', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'trace-abc-12345').expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-12345');
  });
});

describe('authentication', () => {
  it('rejects protected routes without a session', async () => {
    const res = await request(app).get('/api/v1/dashboard/summary').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a wrong password and an unknown email with the same error', async () => {
    const a = await request(app).post('/api/v1/auth/login').send({ ...ADMIN, password: 'nope' }).expect(401);
    const b = await request(app).post('/api/v1/auth/login').send({ email: 'ghost@example.test', password: 'x' }).expect(401);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(b.body.error).toMatchObject({ code: a.body.error.code, message: a.body.error.message });
    expect(await AuditLogModel.countDocuments({ action: 'auth.login_failed' })).toBeGreaterThanOrEqual(2);
  });

  it('validates the login payload', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('logs in with an httpOnly SameSite=Strict cookie and returns the user without secrets', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: ADMIN.email.toUpperCase(), password: ADMIN.password }).expect(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/shorts_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(res.body.user).toMatchObject({ email: ADMIN.email, role: 'ADMIN' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });

  it('GET /auth/me returns the current user; logout ends the session', async () => {
    const agent = await loggedIn();
    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.email).toBe(ADMIN.email);
    await agent.post('/api/v1/auth/logout').expect(204);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('a disabled user loses access immediately, even with a valid token', async () => {
    const agent = await loggedIn(VIEWER);
    await UserModel.updateOne({ email: VIEWER.email }, { disabled: true });
    await agent.get('/api/v1/auth/me').expect(401);
    await request(app).post('/api/v1/auth/login').send(VIEWER).expect(401);
    await UserModel.updateOne({ email: VIEWER.email }, { disabled: false });
  });

  it('rejects a tampered token', async () => {
    await request(app).get('/api/v1/auth/me').set('Cookie', 'shorts_session=eyJhbGciOiJIUzI1NiJ9.e30.bad').expect(401);
  });

  it('requires JSON for mutating requests with a body (CSRF guard)', async () => {
    const res = await request(app).post('/api/v1/auth/login').type('form').send('email=a@b.c&password=x').expect(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('dashboard and system', () => {
  it('returns zeroed summary counts on an empty system', async () => {
    const agent = await loggedIn();
    const res = await agent.get('/api/v1/dashboard/summary').expect(200);
    expect(res.body.counts).toEqual({
      streamers: 0,
      liveStreamers: 0,
      sessionsWaiting: 0,
      sessionsProcessing: 0,
      shortsGeneratedToday: 0,
      shortsPublishedToday: 0,
      failedJobs: 0,
      awaitingReview: 0,
      queuedUploads: 0,
    });
    expect(res.body.costs).toEqual({ spentUsd: 0, budgetUsd: 0 });
    expect(res.body.topShorts).toEqual([]);
    expect(res.body.recentSessions).toEqual([]);
  });

  it('reports every pipeline queue in system status', async () => {
    const agent = await loggedIn();
    const res = await agent.get('/api/v1/system/status').expect(200);
    expect(res.body.ready.status).toBe('ready');
    expect(res.body.queues.map((q: { queue: string }) => q.queue).sort()).toEqual([...ALL_QUEUE_NAMES].sort());
    expect(Array.isArray(res.body.workers)).toBe(true);
  });
});

describe('jobs', () => {
  it('lists, filters and paginates processing jobs', async () => {
    await ProcessingJobModel.create([
      { jobType: JobType.CLEANUP, queueName: 'cleanup', idempotencyKey: 'k1', status: JobStatus.COMPLETED },
      { jobType: JobType.CLEANUP, queueName: 'cleanup', idempotencyKey: 'k2', status: JobStatus.FAILED, lastError: 'boom' },
    ]);
    const agent = await loggedIn();
    const all = await agent.get('/api/v1/jobs').expect(200);
    expect(all.body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    const failed = await agent.get('/api/v1/jobs').query({ status: 'FAILED' }).expect(200);
    expect(failed.body.items).toHaveLength(1);
    expect(failed.body.items[0].lastError).toBe('boom');
    const one = await agent.get(`/api/v1/jobs/${failed.body.items[0].id}`).expect(200);
    expect(one.body.status).toBe('FAILED');
    await agent.get('/api/v1/jobs').query({ status: 'NOPE' }).expect(400);
    await agent.get('/api/v1/jobs/not-an-id').expect(404);

    const summary = await agent.get('/api/v1/dashboard/summary').expect(200);
    expect(summary.body.counts.failedJobs).toBe(1);
  });
});

describe('settings', () => {
  it('returns seeded defaults (manual approval, 30–60s clips, 5 per stream)', async () => {
    const agent = await loggedIn();
    const res = await agent.get('/api/v1/settings').expect(200);
    expect(res.body.publishing.mode).toBe('MANUAL_APPROVAL');
    expect(res.body.clips).toMatchObject({ minDurationSeconds: 30, maxDurationSeconds: 60, maxClipsPerStream: 5 });
    expect(res.body.youtube.connected).toBe(false);
  });

  it('applies a partial update, keeps other fields, and audits it', async () => {
    const agent = await loggedIn();
    const res = await agent.patch('/api/v1/settings').send({ clips: { maxClipsPerStream: 8 } }).expect(200);
    expect(res.body.clips.maxClipsPerStream).toBe(8);
    expect(res.body.clips.minDurationSeconds).toBe(30);
    const again = await agent.get('/api/v1/settings').expect(200);
    expect(again.body.clips.maxClipsPerStream).toBe(8);
    expect(await AuditLogModel.countDocuments({ action: 'settings.update' })).toBe(1);
  });

  it('rejects cross-field violations and unknown keys', async () => {
    const agent = await loggedIn();
    const bad = await agent.patch('/api/v1/settings').send({ clips: { minDurationSeconds: 90, maxDurationSeconds: 60 } }).expect(400);
    expect(JSON.stringify(bad.body.error.details)).toMatch(/minDurationSeconds/);
    await agent.patch('/api/v1/settings').send({ hacker: { x: 1 } }).expect(400);
    await agent.patch('/api/v1/settings').send({ monitoring: { intervalSeconds: 5 } }).expect(400);
  });

  it('forbids viewers from changing settings', async () => {
    const agent = await loggedIn(VIEWER);
    await agent.get('/api/v1/settings').expect(200);
    const res = await agent.patch('/api/v1/settings').send({ clips: { maxClipsPerStream: 2 } }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
