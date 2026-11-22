import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstagramGraphClient, InstagramPublishError, reelCaption } from '../src';

function fakeFetch(replies: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    let body = '';
    if (init?.body instanceof URLSearchParams) body = init.body.toString();
    else if (init?.body) body = `stream`;
    calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body });
    const r = replies.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('InstagramGraphClient', () => {
  it('runs the resumable Reels flow', async () => {
    const { fn, calls } = fakeFetch([{ body: { id: 'C9', uri: 'https://rupload.facebook.com/ig-api-upload/v99.0/C9' } }, { body: { success: true } }, { body: { status_code: 'FINISHED' } }, { body: { id: 'M9' } }]);
    const c = new InstagramGraphClient({ fetchFn: fn, version: 'v99.0' });
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ig-')), 'r.mp4');
    await fs.writeFile(file, Buffer.alloc(77));
    expect(await c.createReelContainer('TOK', '42', 'Hello #gta')).toBe('C9');
    await c.uploadVideo('TOK', 'C9', file);
    expect(await c.containerStatus('TOK', 'C9')).toEqual({ status: 'FINISHED', message: null });
    expect(await c.publish('TOK', '42', 'C9')).toBe('M9');

    expect(calls[0]).toMatchObject({ url: 'https://graph.instagram.com/v99.0/42/media', method: 'POST' });
    expect(new URLSearchParams(calls[0]!.body).get('media_type')).toBe('REELS');
    expect(new URLSearchParams(calls[0]!.body).get('upload_type')).toBe('resumable');
    expect(calls[1]).toMatchObject({ url: 'https://rupload.facebook.com/ig-api-upload/v99.0/C9', headers: { Authorization: 'OAuth TOK', offset: '0', file_size: '77' } });
    expect(calls[3]!.url).toBe('https://graph.instagram.com/v99.0/42/media_publish');
  });

  it('maps Graph errors without leaking the token', async () => {
    const { fn } = fakeFetch([
      { status: 400, body: { error: { code: 190, message: 'Session expired' } } },
      { status: 400, body: { error: { code: 9, error_subcode: 2207042, message: 'limit' } } },
      { status: 400, body: { error: { code: 100, message: 'bad caption' } } },
    ]);
    const c = new InstagramGraphClient({ fetchFn: fn });
    const e1 = (await c.me('SECRET').catch((e: unknown) => e)) as InstagramPublishError;
    expect(e1).toMatchObject({ code: 'AUTH', retryable: false });
    expect(e1.message).not.toContain('SECRET');
    expect(await c.publish('SECRET', '1', 'C').catch((e) => e)).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 3_600_000 });
    expect(await c.publish('SECRET', '1', 'C').catch((e) => e)).toMatchObject({ code: 'BAD_REQUEST', retryable: false });
  });

  it('builds captions with deduplicated hashtags within limits', () => {
    expect(reelCaption('Title', 'Body #GTA', ['gta', 'clutch play', ''])).toBe('Title\n\nBody #GTA\n\n#clutchplay');
    expect(reelCaption('x'.repeat(3000), '', []).length).toBe(2200);
  });
});

describe('Facebook Login tokens', () => {
  it('finds the Instagram account through the linked Page and uses graph.facebook.com', async () => {
    const { fn, calls } = fakeFetch([
      { body: { data: [{ name: 'Page', instagram_business_account: { id: '1789', username: 'creator' } }] } },
      { body: { data: [] } },
      { body: { id: 'C1' } },
    ]);
    const c = new InstagramGraphClient({ fetchFn: fn, version: 'v99.0' });
    expect(await c.me('EAAtoken')).toEqual({ userId: '1789', username: 'creator', accountType: 'BUSINESS' });
    expect(calls[0]!.url).toContain('https://graph.facebook.com/v99.0/me/accounts?');
    await expect(c.me('EAAtoken')).rejects.toThrow(/pages_show_list/);
    await c.createReelContainer('EAAtoken', '1789', 'hi');
    expect(calls[2]!.url).toBe('https://graph.facebook.com/v99.0/1789/media');
    await expect(c.refresh('EAAtoken')).rejects.toMatchObject({ code: 'AUTH' });
  });
});
