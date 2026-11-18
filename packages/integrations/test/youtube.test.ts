import { describe, expect, it } from 'vitest';
import { ProviderError, YouTubeDataApiProvider, createMemoryQuotaTracker, pacificDay, parseChannelInput } from '../src';

describe('parseChannelInput', () => {
  const ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
  it.each([
    [ID, { kind: 'id', value: ID }],
    [`https://www.youtube.com/channel/${ID}`, { kind: 'id', value: ID }],
    [`youtube.com/channel/${ID}/videos`, { kind: 'id', value: ID }],
    ['@SomeStreamer', { kind: 'handle', value: '@SomeStreamer' }],
    ['https://m.youtube.com/@some.streamer/live', { kind: 'handle', value: '@some.streamer' }],
    ['https://www.youtube.com/user/LegacyName', { kind: 'username', value: 'LegacyName' }],
    ['https://www.youtube.com/c/CustomName', { kind: 'custom', value: 'CustomName' }],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', { kind: 'video', value: 'dQw4w9WgXcQ' }],
    ['https://youtu.be/dQw4w9WgXcQ', { kind: 'video', value: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?si=x', { kind: 'video', value: 'dQw4w9WgXcQ' }],
  ])('parses %s', (input, expected) => {
    expect(parseChannelInput(input)).toEqual(expected);
  });

  it.each(['', 'hello world', 'https://evil.example.com/@streamer', 'javascript:alert(1)', 'https://www.youtube.com/', 'ftp://youtube.com/@abc', '@a'])(
    'rejects %s',
    (input) => {
      expect(parseChannelInput(input)).toBeNull();
    },
  );
});

describe('pacificDay', () => {
  it('uses the Pacific calendar day (quota reset boundary)', () => {
    expect(pacificDay(new Date('2026-01-02T07:30:00Z'))).toBe('2026-01-01');
    expect(pacificDay(new Date('2026-01-02T08:30:00Z'))).toBe('2026-01-02');
  });
});

type Handler = (url: URL) => { status: number; body: unknown };

function fakeFetch(handler: Handler) {
  const calls: URL[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const { status, body } = handler(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

describe('YouTubeDataApiProvider', () => {
  it('resolves a handle via channels.list forHandle and records 1 quota unit', async () => {
    const quota = createMemoryQuotaTracker();
    const { fn, calls } = fakeFetch(() => ({
      status: 200,
      body: { items: [{ id: 'UCabcdefghijklmnopqrstuv', snippet: { title: 'Streamer', customUrl: '@streamer', thumbnails: { default: { url: 'https://img/t.jpg' } } } }] },
    }));
    const p = new YouTubeDataApiProvider({ apiKey: 'k', liveDetection: 'rss', quota, fetchFn: fn });
    const ch = await p.resolveChannel({ kind: 'handle', value: '@streamer' });
    expect(ch).toEqual({ channelId: 'UCabcdefghijklmnopqrstuv', title: 'Streamer', handle: '@streamer', thumbnailUrl: 'https://img/t.jpg' });
    expect(calls[0]!.pathname).toBe('/youtube/v3/channels');
    expect(calls[0]!.searchParams.get('forHandle')).toBe('@streamer');
    expect(await quota.usedToday()).toBe(1);
  });

  it('returns null for an unknown channel', async () => {
    const { fn } = fakeFetch(() => ({ status: 200, body: { items: [] } }));
    const p = new YouTubeDataApiProvider({ apiKey: 'k', liveDetection: 'rss', fetchFn: fn });
    expect(await p.resolveChannel({ kind: 'id', value: 'UCabcdefghijklmnopqrstuv' })).toBeNull();
  });

  it('discovers videos from the free RSS feed (no quota)', async () => {
    const quota = createMemoryQuotaTracker();
    const xml = '<feed><entry><yt:videoId>aaaaaaaaaaa</yt:videoId></entry><entry><yt:videoId>bbbbbbbbbbb</yt:videoId></entry></feed>';
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: xml }));
    const p = new YouTubeDataApiProvider({ apiKey: 'k', liveDetection: 'rss', quota, fetchFn: fn });
    expect(await p.listCandidateVideoIds('UCabcdefghijklmnopqrstuv')).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(calls[0]!.hostname).toBe('www.youtube.com');
    expect(await quota.usedToday()).toBe(0);
  });

  it('batches videos.list into groups of 50 and maps live details', async () => {
    const quota = createMemoryQuotaTracker();
    const { fn, calls } = fakeFetch((url) => ({
      status: 200,
      body: {
        items: url.searchParams
          .get('id')!
          .split(',')
          .map((id) => ({
            id,
            snippet: { channelId: 'UCx', title: `t-${id}`, liveBroadcastContent: id === 'v0' ? 'live' : 'none' },
            liveStreamingDetails: id === 'v0' ? { actualStartTime: '2026-01-01T00:00:00Z' } : undefined,
          })),
      },
    }));
    const p = new YouTubeDataApiProvider({ apiKey: 'k', liveDetection: 'rss', quota, fetchFn: fn });
    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const videos = await p.getVideos([...ids, 'v0']);
    expect(calls).toHaveLength(3);
    expect(videos).toHaveLength(120);
    expect(videos[0]).toMatchObject({ videoId: 'v0', liveBroadcastContent: 'live', actualStartTime: new Date('2026-01-01T00:00:00Z'), actualEndTime: null });
    expect(await quota.usedToday()).toBe(3);
  });

  it('maps quotaExceeded to a non-retryable error, pauses calls, and never leaks the key', async () => {
    const quota = createMemoryQuotaTracker();
    const { fn } = fakeFetch(() => ({ status: 403, body: { error: { errors: [{ reason: 'quotaExceeded' }] } } }));
    const p = new YouTubeDataApiProvider({ apiKey: 'SECRET-KEY', liveDetection: 'rss', quota, fetchFn: fn });
    const err = await p.getVideos(['v1']).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false });
    expect(err.message).not.toContain('SECRET-KEY');
    expect(await quota.pausedUntil()).not.toBeNull();
    await expect(p.getVideos(['v1'])).rejects.toMatchObject({ code: 'PAUSED' });
  });

  it('treats network failures as retryable', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const p = new YouTubeDataApiProvider({ apiKey: 'k', liveDetection: 'rss', fetchFn: fn });
    await expect(p.getVideos(['v1'])).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
  });

  it('uses search.list (100 units) only when the search strategy is configured', async () => {
    const quota = createMemoryQuotaTracker();
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: { items: [{ id: { videoId: 'livevideo01' } }] } }));
    const p = new YouTubeDataApiProvider({ apiKey: 'k', liveDetection: 'search', quota, fetchFn: fn });
    expect(await p.listCandidateVideoIds('UCx')).toEqual(['livevideo01']);
    expect(calls[0]!.searchParams.get('eventType')).toBe('live');
    expect(await quota.usedToday()).toBe(100);
  });
});
