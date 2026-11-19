import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

/** Scopes for uploading to, and identifying, the central channel. */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

export class YouTubePublishError extends Error {
  constructor(
    public readonly code: 'AUTH' | 'RECONNECT' | 'QUOTA' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAVAILABLE' | 'SESSION_EXPIRED',
    message: string,
    public readonly retryable: boolean,
    /** When the operation may be tried again (quota resets, rate limits). */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'YouTubePublishError';
  }
}

/** Milliseconds until the next midnight in America/Los_Angeles, when YouTube API quota resets. */
export function msUntilQuotaReset(now = new Date()): number {
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const next = new Date(pt);
  next.setHours(24, 5, 0, 0); // 5 minutes past midnight PT
  return next.getTime() - pt.getTime();
}

async function googleError(res: Response, what: string): Promise<YouTubePublishError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: Array<{ reason?: string }> } | string; error_description?: string };
  const err = typeof body.error === 'object' ? body.error : undefined;
  const reason = err?.errors?.[0]?.reason ?? (typeof body.error === 'string' ? body.error : '');
  const msg = `${what}: ${err?.message ?? body.error_description ?? reason ?? `HTTP ${res.status}`}`.slice(0, 400);
  if (reason === 'invalid_grant') return new YouTubePublishError('RECONNECT', 'YouTube access was revoked or expired. Reconnect the channel in Settings.', false);
  if (res.status === 401) return new YouTubePublishError('AUTH', msg, true);
  if (['quotaExceeded', 'dailyLimitExceeded', 'uploadLimitExceeded'].includes(reason)) {
    return new YouTubePublishError('QUOTA', `${msg} (waiting for the daily quota to reset)`, true, msUntilQuotaReset());
  }
  if (res.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') return new YouTubePublishError('RATE_LIMITED', msg, true, 60_000);
  if (res.status >= 500) return new YouTubePublishError('UNAVAILABLE', msg, true);
  if (res.status === 403 && (reason === 'insufficientPermissions' || reason === 'forbidden')) return new YouTubePublishError('RECONNECT', `${msg}. Reconnect the channel and grant upload access.`, false);
  return new YouTubePublishError('BAD_REQUEST', msg, false);
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
}

/** Google OAuth 2.0 (web server flow) for the central channel (spec §6 Workflow H). */
export class YouTubeOAuthClient {
  constructor(
    private readonly opts: { clientId: string; clientSecret: string; redirectUri: string; authBase?: string; tokenUrl?: string; apiBase?: string },
  ) {}

  authUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: 'code',
      scope: YOUTUBE_SCOPES.join(' '),
      // Offline + consent so Google returns a refresh token every time.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${this.opts.authBase ?? 'https://accounts.google.com/o/oauth2/v2/auth'}?${p}`;
  }

  private async token(params: Record<string, string>): Promise<OAuthTokens> {
    const res = await fetch(this.opts.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.opts.clientId, client_secret: this.opts.clientSecret, ...params }),
      signal: AbortSignal.timeout(30_000),
    }).catch((err: Error) => {
      throw new YouTubePublishError('UNAVAILABLE', `Google OAuth unreachable: ${err.message}`, true);
    });
    if (!res.ok) throw await googleError(res, 'Google OAuth');
    const d = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: Date.now() + (d.expires_in - 60) * 1000, scope: d.scope ?? '' };
  }

  exchangeCode(code: string) {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.opts.redirectUri });
  }

  refresh(refreshToken: string) {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(token: string): Promise<void> {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  }

  /** The channel the tokens belong to. */
  async channel(accessToken: string): Promise<{ id: string; title: string }> {
    const res = await fetch(`${this.opts.apiBase ?? 'https://www.googleapis.com/youtube/v3'}/channels?part=snippet&mine=true`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw await googleError(res, 'YouTube channels.list');
    const d = (await res.json()) as { items?: Array<{ id: string; snippet?: { title?: string } }> };
    const ch = d.items?.[0];
    if (!ch) throw new YouTubePublishError('BAD_REQUEST', 'This Google account has no YouTube channel. Create one, then connect again.', false);
    return { id: ch.id, title: ch.snippet?.title ?? ch.id };
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: 'private' | 'unlisted' | 'public';
  language?: string;
}

export interface UploadInput {
  filePath: string;
  metadata: VideoMetadata;
  /** Resumable session from an earlier attempt, if any. */
  resumeUrl: string | null;
  /** Persist the session URL so a crashed upload resumes instead of starting over. */
  onSession: (url: string) => Promise<void>;
  onProgress?: (fraction: number) => Promise<void> | void;
}

export interface YouTubeUploader {
  readonly name: 'youtube' | 'mock';
  upload(input: UploadInput, accessToken: () => Promise<string>): Promise<{ videoId: string }>;
  setThumbnail(videoId: string, jpegPath: string, accessToken: () => Promise<string>): Promise<void>;
}

/** 8 MiB chunks (must be a multiple of 256 KiB). */
const CHUNK = 8 * 1024 * 1024;

/**
 * YouTube Data API resumable upload. Safe to retry: an existing session is
 * queried first, so an upload that already finished returns its video id
 * instead of creating a duplicate.
 */
export class GoogleYouTubeUploader implements YouTubeUploader {
  readonly name = 'youtube' as const;
  constructor(private readonly opts: { uploadBase?: string } = {}) {}

  async upload(input: UploadInput, accessToken: () => Promise<string>): Promise<{ videoId: string }> {
    const size = (await fsp.stat(input.filePath)).size;
    let session = input.resumeUrl;
    let offset = 0;

    if (session) {
      const st = await this.put(session, await accessToken(), Buffer.alloc(0), `bytes */${size}`);
      if (st.done) return { videoId: st.videoId };
      if (st.expired) session = null;
      else offset = st.next;
    }
    if (!session) {
      session = await this.start(input.metadata, size, await accessToken());
      await input.onSession(session);
      offset = 0;
    }

    const fh = await fsp.open(input.filePath, 'r');
    try {
      for (;;) {
        const len = Math.min(CHUNK, size - offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        const st = await this.put(session, await accessToken(), buf, `bytes ${offset}-${offset + len - 1}/${size}`);
        if (st.done) {
          await input.onProgress?.(1);
          return { videoId: st.videoId };
        }
        if (st.expired) throw new YouTubePublishError('SESSION_EXPIRED', 'The upload session expired; it will restart', true);
        offset = st.next;
        await input.onProgress?.(offset / size);
      }
    } finally {
      await fh.close();
    }
  }

  private async start(m: VideoMetadata, size: number, token: string): Promise<string> {
    const url = `${this.opts.uploadBase ?? 'https://www.googleapis.com/upload/youtube/v3'}/videos?uploadType=resumable&part=snippet,status`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: { title: m.title, description: m.description, tags: m.tags, categoryId: m.categoryId, ...(m.language ? { defaultLanguage: m.language, defaultAudioLanguage: m.language } : {}) },
        status: { privacyStatus: m.privacyStatus, selfDeclaredMadeForKids: false, embeddable: true },
      }),
      signal: AbortSignal.timeout(60_000),
    }).catch((err: Error) => {
      throw new YouTubePublishError('UNAVAILABLE', `YouTube upload API unreachable: ${err.message}`, true);
    });
    if (!res.ok) throw await googleError(res, 'YouTube videos.insert');
    const location = res.headers.get('location');
    if (!location) throw new YouTubePublishError('UNAVAILABLE', 'YouTube did not return an upload session', true);
    return location;
  }

  private async put(
    session: string,
    token: string,
    body: Buffer,
    range: string,
  ): Promise<{ done: true; videoId: string } | { done: false; expired: true } | { done: false; expired: false; next: number }> {
    const res = await fetch(session, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(body.length), 'Content-Range': range },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10 * 60_000),
    }).catch((err: Error) => {
      throw new YouTubePublishError('UNAVAILABLE', `Upload interrupted: ${err.message}`, true);
    });
    if (res.status === 200 || res.status === 201) {
      const v = (await res.json()) as { id?: string };
      if (!v.id) throw new YouTubePublishError('UNAVAILABLE', 'YouTube finished the upload without a video id', true);
      return { done: true, videoId: v.id };
    }
    if (res.status === 308) {
      const m = res.headers.get('range')?.match(/bytes=0-(\d+)/);
      return { done: false, expired: false, next: m ? Number(m[1]) + 1 : 0 };
    }
    if (res.status === 404 || res.status === 410) return { done: false, expired: true };
    throw await googleError(res, 'YouTube upload');
  }

  async setThumbnail(videoId: string, jpegPath: string, accessToken: () => Promise<string>): Promise<void> {
    const res = await fetch(`${this.opts.uploadBase ?? 'https://www.googleapis.com/upload/youtube/v3'}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'image/jpeg' },
      body: new Uint8Array(await fsp.readFile(jpegPath)),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw await googleError(res, 'YouTube thumbnails.set');
  }
}

/** Development stand-in: "uploads" instantly and returns a fake video id. */
export class MockYouTubeUploader implements YouTubeUploader {
  readonly name = 'mock' as const;
  readonly uploads: Array<{ videoId: string; metadata: VideoMetadata; bytes: number }> = [];

  async upload(input: UploadInput): Promise<{ videoId: string }> {
    const bytes = (await fsp.stat(input.filePath)).size;
    await input.onSession(`mock://upload/${crypto.randomUUID()}`);
    await input.onProgress?.(1);
    const videoId = `mock${crypto.randomBytes(4).toString('hex')}`;
    this.uploads.push({ videoId, metadata: input.metadata, bytes });
    return { videoId };
  }

  async setThumbnail(): Promise<void> {}
}

export interface VideoStats {
  id: string;
  views: number;
  likes: number;
  comments: number;
  privacyStatus: string | null;
}

/** Statistics for up to 50 videos per call (1 quota unit). Missing ids were deleted on YouTube. */
export async function fetchVideoStats(ids: string[], accessToken: string, apiBase = 'https://www.googleapis.com/youtube/v3'): Promise<VideoStats[]> {
  if (!ids.length) return [];
  const res = await fetch(`${apiBase}/videos?part=statistics,status&maxResults=50&id=${ids.slice(0, 50).map(encodeURIComponent).join(',')}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw await googleError(res, 'YouTube videos.list');
  const d = (await res.json()) as { items?: Array<{ id: string; statistics?: Record<string, string>; status?: { privacyStatus?: string } }> };
  return (d.items ?? []).map((v) => ({
    id: v.id,
    views: Number(v.statistics?.viewCount ?? 0),
    likes: Number(v.statistics?.likeCount ?? 0),
    comments: Number(v.statistics?.commentCount ?? 0),
    privacyStatus: v.status?.privacyStatus ?? null,
  }));
}

export const youtubeShortUrl = (videoId: string) => `https://www.youtube.com/shorts/${videoId}`;
