import type { QuotaTracker } from './quota';
import { ProviderError, type ChannelRef, type LiveChatPage, type LiveChatProvider, type ResolvedChannel, type VideoDetails, type YouTubeMetadataProvider } from './types';

/**
 * YouTube Data API v3 metadata provider.
 *
 * Quota-aware design (verify unit costs against current Google docs):
 *  - channels.list / videos.list: 1 unit per call; videos.list takes 50 IDs.
 *  - search.list: 100 units — used only for legacy /c/ URLs and the opt-in
 *    `search` live-detection strategy.
 *  - Public uploads RSS feed: no quota. Default discovery path.
 */
export interface DataApiProviderOptions {
  apiKey: string;
  liveDetection: 'rss' | 'search';
  quota?: QuotaTracker;
  fetchFn?: typeof fetch;
  apiBase?: string;
  feedBase?: string;
  timeoutMs?: number;
}

// liveChatMessages.list is listed at 5 units per call (verify against current Google docs).
const COST = { channels: 1, videos: 1, search: 100, liveChat: 5 } as const;
const VIDEO_BATCH = 50;
const RSS_VIDEO_ID_RE = /<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/g;

interface ApiChannel {
  id: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string }; medium?: { url?: string } } };
}
interface ApiVideo {
  id: string;
  snippet?: { channelId?: string; title?: string; liveBroadcastContent?: string };
  liveStreamingDetails?: { actualStartTime?: string; actualEndTime?: string; scheduledStartTime?: string };
}

const toDate = (v?: string) => (v ? new Date(v) : null);

export class YouTubeDataApiProvider implements YouTubeMetadataProvider, LiveChatProvider {
  readonly name = 'youtube' as const;
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;
  private readonly feedBase: string;

  constructor(private readonly opts: DataApiProviderOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.apiBase = opts.apiBase ?? 'https://www.googleapis.com/youtube/v3';
    this.feedBase = opts.feedBase ?? 'https://www.youtube.com/feeds/videos.xml';
  }

  async resolveChannel(ref: ChannelRef): Promise<ResolvedChannel | null> {
    switch (ref.kind) {
      case 'id':
        return this.channelBy({ id: ref.value });
      case 'handle':
        return this.channelBy({ forHandle: ref.value });
      case 'username':
        return this.channelBy({ forUsername: ref.value });
      case 'custom': {
        // Legacy custom URLs have no direct lookup; fall back to a channel search.
        const res = await this.api<{ items?: Array<{ id?: { channelId?: string } }> }>(
          'search',
          { part: 'id', type: 'channel', q: ref.value, maxResults: '1' },
          COST.search,
        );
        const id = res.items?.[0]?.id?.channelId;
        return id ? this.channelBy({ id }) : null;
      }
      case 'video': {
        const [video] = await this.getVideos([ref.value]);
        return video ? this.channelBy({ id: video.channelId }) : null;
      }
    }
  }

  async listCandidateVideoIds(channelId: string): Promise<string[]> {
    if (this.opts.liveDetection === 'search') {
      const res = await this.api<{ items?: Array<{ id?: { videoId?: string } }> }>(
        'search',
        { part: 'id', channelId, eventType: 'live', type: 'video', maxResults: '5' },
        COST.search,
      );
      return (res.items ?? []).map((i) => i.id?.videoId).filter((v): v is string => Boolean(v));
    }
    const url = `${this.feedBase}?channel_id=${encodeURIComponent(channelId)}`;
    const res = await this.request(url);
    if (res.status === 404) throw new ProviderError('NOT_FOUND', `No uploads feed for channel ${channelId}`, false);
    if (!res.ok) throw new ProviderError(res.status >= 500 ? 'NETWORK' : 'BAD_RESPONSE', `Feed request failed (${res.status})`, res.status >= 500);
    const xml = await res.text();
    return [...new Set([...xml.matchAll(RSS_VIDEO_ID_RE)].map((m) => m[1]!))];
  }

  async getVideos(videoIds: string[]): Promise<VideoDetails[]> {
    const unique = [...new Set(videoIds)];
    const out: VideoDetails[] = [];
    for (let i = 0; i < unique.length; i += VIDEO_BATCH) {
      const batch = unique.slice(i, i + VIDEO_BATCH);
      const res = await this.api<{ items?: ApiVideo[] }>(
        'videos',
        { part: 'snippet,liveStreamingDetails', id: batch.join(','), maxResults: String(VIDEO_BATCH) },
        COST.videos,
      );
      for (const v of res.items ?? []) {
        const lbc = v.snippet?.liveBroadcastContent;
        out.push({
          videoId: v.id,
          channelId: v.snippet?.channelId ?? '',
          title: v.snippet?.title ?? '',
          liveBroadcastContent: lbc === 'live' || lbc === 'upcoming' ? lbc : 'none',
          actualStartTime: toDate(v.liveStreamingDetails?.actualStartTime),
          actualEndTime: toDate(v.liveStreamingDetails?.actualEndTime),
          scheduledStartTime: toDate(v.liveStreamingDetails?.scheduledStartTime),
        });
      }
    }
    return out;
  }

  async getActiveLiveChatId(videoId: string): Promise<string | null> {
    const res = await this.api<{ items?: Array<{ liveStreamingDetails?: { activeLiveChatId?: string } }> }>(
      'videos',
      { part: 'liveStreamingDetails', id: videoId, fields: 'items(liveStreamingDetails(activeLiveChatId))' },
      COST.videos,
    );
    return res.items?.[0]?.liveStreamingDetails?.activeLiveChatId ?? null;
  }

  async listChatMessages(liveChatId: string, pageToken: string | null): Promise<LiveChatPage> {
    try {
      const res = await this.api<{ nextPageToken?: string; pollingIntervalMillis?: number; offlineAt?: string; items?: Array<{ snippet?: { publishedAt?: string; authorChannelId?: string } }> }>(
        'liveChat/messages',
        {
          liveChatId,
          part: 'snippet',
          maxResults: '2000',
          fields: 'nextPageToken,pollingIntervalMillis,offlineAt,items(snippet(publishedAt,authorChannelId))',
          ...(pageToken ? { pageToken } : {}),
        },
        COST.liveChat,
      );
      const valid = (res.items ?? []).filter((i) => {
        const d = toDate(i.snippet?.publishedAt);
        return d !== null && !Number.isNaN(d.getTime());
      });
      return {
        messageTimes: valid.map((i) => toDate(i.snippet!.publishedAt)!),
        authors: valid.map((i) => i.snippet?.authorChannelId ?? null),
        nextPageToken: res.nextPageToken ?? null,
        pollingIntervalMs: res.pollingIntervalMillis ?? 5000,
        ended: Boolean(res.offlineAt),
      };
    } catch (err) {
      if (err instanceof ProviderError && /liveChatEnded|liveChatNotFound|liveChatDisabled|forbidden/.test(err.message)) {
        return { messageTimes: [], nextPageToken: null, pollingIntervalMs: 0, ended: true };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------

  private async channelBy(filter: Record<string, string>): Promise<ResolvedChannel | null> {
    const res = await this.api<{ items?: ApiChannel[] }>('channels', { part: 'snippet', ...filter }, COST.channels);
    const c = res.items?.[0];
    if (!c) return null;
    const custom = c.snippet?.customUrl;
    return {
      channelId: c.id,
      title: c.snippet?.title ?? c.id,
      handle: custom ? (custom.startsWith('@') ? custom : `@${custom}`) : null,
      thumbnailUrl: c.snippet?.thumbnails?.medium?.url ?? c.snippet?.thumbnails?.default?.url ?? null,
    };
  }

  private async api<T>(resource: string, params: Record<string, string>, units: number): Promise<T> {
    const pausedUntil = await this.opts.quota?.pausedUntil();
    if (pausedUntil) throw new ProviderError('PAUSED', `YouTube API calls paused until ${pausedUntil.toISOString()} (quota)`, true);

    const qs = new URLSearchParams({ ...params, key: this.opts.apiKey });
    const res = await this.request(`${this.apiBase}/${resource}?${qs}`);
    await this.opts.quota?.record(units);
    if (res.ok) return (await res.json()) as T;

    const body = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: Array<{ reason?: string }> } } | null;
    const reason = body?.error?.errors?.[0]?.reason ?? '';
    // Never echo the URL: it contains the API key.
    const msg = `YouTube ${resource} failed (${res.status}${reason ? ` ${reason}` : ''})`;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      await this.opts.quota?.pause(30 * 60 * 1000);
      throw new ProviderError('QUOTA_EXCEEDED', msg, false);
    }
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || res.status === 429) {
      throw new ProviderError('RATE_LIMITED', msg, true);
    }
    if (reason === 'keyInvalid' || reason === 'accessNotConfigured' || res.status === 401) throw new ProviderError('CONFIG', msg, false);
    if (res.status === 404) throw new ProviderError('NOT_FOUND', msg, false);
    throw new ProviderError(res.status >= 500 ? 'NETWORK' : 'BAD_RESPONSE', msg, res.status >= 500);
  }

  private async request(url: string): Promise<Response> {
    try {
      return await this.fetchFn(url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000), headers: { Accept: 'application/json, application/xml' } });
    } catch (err) {
      // Show the underlying cause (e.g. ECONNRESET, ENOTFOUND, timeout) but never the URL (it holds the key).
      const e = err as Error & { cause?: { code?: string; message?: string } };
      const cause = e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.cause?.message ?? e.message);
      throw new ProviderError('NETWORK', `YouTube request failed: ${e.name} (${String(cause).replace(/key=[^&\s]+/g, 'key=…').slice(0, 120)})`, true);
    }
  }
}
