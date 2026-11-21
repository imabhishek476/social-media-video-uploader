import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InstagramPublishError, type InstagramGraphClient } from '@shorts/integrations';
import { ADMIN, VIEWER, setupTestApp } from './helpers';
import { MockYouTubeProvider } from '@shorts/integrations/testing';

const fakeIg = {
  async me(token: string) {
    if (token.startsWith('bad')) throw new InstagramPublishError('AUTH', 'Invalid OAuth access token', false);
    return { userId: '1784', username: 'my_creator', accountType: 'BUSINESS' };
  },
} as unknown as InstagramGraphClient;

let app: Express;
let teardown: () => Promise<void>;
beforeAll(async () => {
  const ctx = await setupTestApp(new MockYouTubeProvider(), { instagram: fakeIg });
  app = ctx.app;
  teardown = ctx.teardown;
});
afterAll(async () => teardown());

describe('Instagram integration routes', () => {
  it('connects with a verified token, shows status in settings and disconnects', async () => {
    const admin = request.agent(app);
    await admin.post('/api/v1/auth/login').send(ADMIN).expect(200);
    const viewer = request.agent(app);
    await viewer.post('/api/v1/auth/login').send(VIEWER).expect(200);
    await viewer.put('/api/v1/integrations/instagram').send({ accessToken: 'x'.repeat(30) }).expect(403);
    await admin.put('/api/v1/integrations/instagram').send({ accessToken: 'short' }).expect(400);

    const bad = await admin.put('/api/v1/integrations/instagram').send({ accessToken: 'bad-token-xxxxxxxxxxxxxxxxxx' }).expect(400);
    expect(bad.body.error.message).toMatch(/rejected this token/);
    const ok = await admin.put('/api/v1/integrations/instagram').send({ accessToken: 'good-token-xxxxxxxxxxxxxxxxx' }).expect(200);
    expect(ok.body).toMatchObject({ connected: true, username: 'my_creator' });
    const s = await admin.get('/api/v1/settings').expect(200);
    expect(s.body.instagram).toMatchObject({ connected: true, userId: '1784' });
    expect(JSON.stringify(s.body)).not.toContain('good-token');
    await admin.delete('/api/v1/integrations/instagram').expect(204);
    expect((await admin.get('/api/v1/settings').expect(200)).body.instagram.connected).toBe(false);
    await admin.post('/api/v1/clips/000000000000000000000000/instagram').expect(404);
  });
});
