import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GoogleYouTubeUploader, YouTubeOAuthClient, YouTubePublishError, finalizeMetadata, msUntilQuotaReset, type MetadataRequest } from '../src';
import { TemplateMetadataGenerator } from '../testing';

type Handler = (req: http.IncomingMessage, body: Buffer) => { status: number; headers?: Record<string, string | undefined>; body?: unknown };
let server: http.Server;
let base: string;
let handler: Handler;
const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; bytes: number; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, bytes: body.length, body: body.length < 5000 ? body.toString() : '' });
      const r = handler(req, body);
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers as Record<string, string>) }).end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen.length = 0;
});

const oauth = () =>
  new YouTubeOAuthClient({ clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost:8080/cb', tokenUrl: `${base}/token`, apiBase: `${base}/yt` });

describe('YouTubeOAuthClient', () => {
  it('builds an offline consent URL with upload scope and state', () => {
    const url = new URL(oauth().authUrl('st4te'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'cid', access_type: 'offline', prompt: 'consent', state: 'st4te', redirect_uri: 'http://localhost:8080/cb' });
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
  });

  it('exchanges the code, refreshes, reads the channel, and maps a revoked grant', async () => {
    handler = (req, body) => {
      if (req.url === '/token') {
        const p = new URLSearchParams(body.toString());
        if (p.get('refresh_token') === 'revoked') return { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
        return { status: 200, body: { access_token: 'at-1', refresh_token: p.get('grant_type') === 'authorization_code' ? 'rt-1' : undefined, expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.upload' } };
      }
      return { status: 200, body: { items: [{ id: 'UCabc', snippet: { title: 'Central' } }] } };
    };
    const tokens = await oauth().exchangeCode('code-1');
    expect(tokens).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' });
    expect(new URLSearchParams(seen[0]!.body).get('code')).toBe('code-1');
    expect((await oauth().refresh('rt-1')).accessToken).toBe('at-1');
    expect(await oauth().channel('at-1')).toEqual({ id: 'UCabc', title: 'Central' });
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer at-1');
    await expect(oauth().refresh('revoked')).rejects.toMatchObject({ code: 'RECONNECT', retryable: false });
  });
});

describe('GoogleYouTubeUploader', () => {
  let file: string;
  const size = 9 * 1024 * 1024 + 123; // two chunks
  beforeAll(async () => {
    file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'yt-up-')), 'short.mp4');
    await fs.writeFile(file, Buffer.alloc(size, 3));
  });
  const meta = { title: 'T', description: 'D', tags: ['a'], categoryId: '20', privacyStatus: 'private' as const, language: 'en' };
  const uploader = () => new GoogleYouTubeUploader({ uploadBase: `${base}/upload` });

  it('starts a resumable session and uploads in chunks', async () => {
    let received = 0;
    handler = (req, body) => {
      if (req.method === 'POST') return { status: 200, headers: { location: `${base}/session/1` } };
      received += body.length;
      return received < size ? { status: 308, headers: { range: `bytes=0-${received - 1}` } } : { status: 201, body: { id: 'vid123' } };
    };
    const sessions: string[] = [];
    const progress: number[] = [];
    const res = await uploader().upload({ filePath: file, metadata: meta, resumeUrl: null, onSession: async (u) => void sessions.push(u), onProgress: (f) => void progress.push(f) }, async () => 'tok');
    expect(res).toEqual({ videoId: 'vid123' });
    expect(sessions).toEqual([`${base}/session/1`]);
    const start = seen[0]!;
    expect(start.url).toBe('/upload/videos?uploadType=resumable&part=snippet,status');
    expect(start.headers['x-upload-content-length']).toBe(String(size));
    expect(JSON.parse(start.body)).toMatchObject({ snippet: { title: 'T', categoryId: '20', defaultLanguage: 'en' }, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } });
    expect(seen.slice(1).map((s) => s.headers['content-range'])).toEqual([`bytes 0-${8 * 1024 * 1024 - 1}/${size}`, `bytes ${8 * 1024 * 1024}-${size - 1}/${size}`]);
    expect(progress.at(-1)).toBe(1);
  });

  it('resumes from where the session stopped, and recovers an upload that already finished', async () => {
    handler = (req, body) => {
      if (req.headers['content-range'] === `bytes */${size}`) return { status: 308, headers: { range: `bytes=0-${8 * 1024 * 1024 - 1}` } };
      return { status: 201, body: { id: `resumed-${body.length}` } };
    };
    const r = await uploader().upload({ filePath: file, metadata: meta, resumeUrl: `${base}/session/2`, onSession: async () => {} }, async () => 'tok');
    expect(r.videoId).toBe(`resumed-${size - 8 * 1024 * 1024}`);
    expect(seen.some((s) => s.method === 'POST')).toBe(false); // no new session → no duplicate video

    handler = () => ({ status: 200, body: { id: 'already-done' } });
    const done = await uploader().upload({ filePath: file, metadata: meta, resumeUrl: `${base}/session/3`, onSession: async () => {} }, async () => 'tok');
    expect(done.videoId).toBe('already-done');
  });

  it('classifies quota, auth and validation errors', async () => {
    handler = () => ({ status: 403, body: { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } });
    const q = await uploader().upload({ filePath: file, metadata: meta, resumeUrl: null, onSession: async () => {} }, async () => 't').catch((e: unknown) => e);
    expect(q).toBeInstanceOf(YouTubePublishError);
    expect(q).toMatchObject({ code: 'QUOTA', retryable: true });
    expect((q as YouTubePublishError).retryAfterMs).toBeGreaterThan(0);

    handler = () => ({ status: 401, body: { error: { message: 'expired' } } });
    await expect(uploader().upload({ filePath: file, metadata: meta, resumeUrl: null, onSession: async () => {} }, async () => 't')).rejects.toMatchObject({ code: 'AUTH' });

    handler = () => ({ status: 400, body: { error: { message: 'invalid title', errors: [{ reason: 'invalidTitle' }] } } });
    await expect(uploader().upload({ filePath: file, metadata: meta, resumeUrl: null, onSession: async () => {} }, async () => 't')).rejects.toMatchObject({ code: 'BAD_REQUEST', retryable: false });
  });

  it('computes the time until the Pacific-time quota reset', () => {
    const ms = msUntilQuotaReset(new Date('2026-11-19T07:00:00Z')); // 23:00 PST
    expect(ms).toBeGreaterThan(60 * 60 * 1000);
    expect(ms).toBeLessThan(66 * 60 * 1000);
  });
});

describe('metadata', () => {
  const req: MetadataRequest = {
    streamerName: 'Mock Gamer',
    streamTitle: 'GTA night',
    sourceUrl: 'https://www.youtube.com/watch?v=abc',
    hook: 'He did NOT see that coming <wow>',
    reason: 'Huge reaction.',
    topic: 'car chase',
    transcriptExcerpt: 'no way',
    durationSeconds: 42,
    language: 'en',
  };

  it('makes metadata upload-safe and credits the source stream', () => {
    const m = finalizeMetadata({ title: `"${'x'.repeat(120)}"`, description: 'A <b>wild</b> moment', hashtags: ['#GTA6', 'gaming', 'Shorts'], tags: ['gta 6', 'y'.repeat(40), 'chase'] }, req);
    expect(m.title.length).toBeLessThanOrEqual(90);
    expect(m.title.startsWith('"')).toBe(false);
    expect(m.description).not.toMatch(/[<>]/);
    expect(m.description).toContain("From Mock Gamer's stream: https://www.youtube.com/watch?v=abc");
    expect(m.description).toContain('#Shorts #GTA6 #gaming');
    expect(m.tags).toEqual(['gta 6', 'chase', 'Mock Gamer', 'gaming', 'Shorts']); // 'GTA6' duplicates 'gta 6'
  });

  it('template generator works offline', async () => {
    const m = await new TemplateMetadataGenerator().generate(req);
    expect(m.title).toBe('He did NOT see that coming wow');
    expect(m.costUsd).toBe(0);
  });
});
