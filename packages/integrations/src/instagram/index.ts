import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';

/**
 * Instagram Reels publishing via the Instagram API with Instagram Login
 * (Business/Creator accounts). Flow: create a REELS container with a
 * resumable upload → send the file bytes → wait until the container is
 * FINISHED → publish it. Verify endpoint details against current Meta docs.
 */

export type InstagramErrorCode = 'AUTH' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAVAILABLE';

export class InstagramPublishError extends Error {
  constructor(
    public readonly code: InstagramErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'InstagramPublishError';
  }
}

export type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

export interface InstagramClientOptions {
  apiBase?: string;
  uploadBase?: string;
  version?: string;
  fetchFn?: typeof fetch;
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

/** Instagram allows 2200 caption characters and 30 hashtags. */
export function reelCaption(title: string, description: string, tags: string[]): string {
  const body = [title.trim(), description.trim()].filter(Boolean).join('\n\n');
  const used = new Set((body.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((h) => h.toLowerCase()));
  const room = Math.max(0, 30 - used.size);
  const extra: string[] = [];
  for (const t of tags) {
    const h = `#${t.replace(/[^\p{L}\p{N}_]/gu, '')}`;
    if (extra.length >= room || h.length < 2 || used.has(h.toLowerCase())) continue;
    used.add(h.toLowerCase());
    extra.push(h);
  }
  const text = extra.length ? `${body}\n\n${extra.join(' ')}` : body;
  return text.length > 2200 ? `${text.slice(0, 2199)}…` : text;
}

export class InstagramGraphClient {
  readonly name = 'instagram';
  private readonly apiBase: string;
  private readonly uploadBase: string;
  private readonly version: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: InstagramClientOptions = {}) {
    this.apiBase = (opts.apiBase ?? 'https://graph.instagram.com').replace(/\/$/, '');
    this.uploadBase = (opts.uploadBase ?? 'https://rupload.facebook.com').replace(/\/$/, '');
    this.version = opts.version ?? 'v23.0';
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** The account a token belongs to. */
  async me(token: string): Promise<{ userId: string; username: string; accountType: string | null }> {
    const r = await this.call<{ user_id?: string; id?: string; username?: string; account_type?: string }>('GET', `/me`, token, { fields: 'user_id,username,account_type' });
    return { userId: String(r.user_id ?? r.id ?? ''), username: r.username ?? '', accountType: r.account_type ?? null };
  }

  /** Extend a long-lived token (valid 60 days; refreshable once it is at least a day old). */
  async refresh(token: string): Promise<{ token: string; expiresAt: Date }> {
    const r = await this.call<{ access_token: string; expires_in?: number }>('GET', '/refresh_access_token', token, { grant_type: 'ig_refresh_token' }, false);
    return { token: r.access_token, expiresAt: new Date(Date.now() + (r.expires_in ?? 60 * 86_400) * 1000) };
  }

  async createReelContainer(token: string, userId: string, caption: string): Promise<string> {
    const r = await this.call<{ id: string }>('POST', `/${userId}/media`, token, { media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: 'true' });
    return r.id;
  }

  async uploadVideo(token: string, containerId: string, filePath: string): Promise<void> {
    const { size } = await fsp.stat(filePath);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.uploadBase}/ig-api-upload/${this.version}/${containerId}`, {
        method: 'POST',
        headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' },
        body: Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream,
        duplex: 'half',
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (err) {
      throw new InstagramPublishError('UNAVAILABLE', `Instagram upload failed: ${(err as Error).message}`, true);
    }
    if (!res.ok) throw this.toError(res.status, (await res.json().catch(() => ({}))) as GraphError, 'upload');
  }

  async containerStatus(token: string, containerId: string): Promise<{ status: ContainerStatus; message: string | null }> {
    const r = await this.call<{ status_code?: string; status?: string }>('GET', `/${containerId}`, token, { fields: 'status_code,status' });
    return { status: (r.status_code as ContainerStatus) ?? 'IN_PROGRESS', message: r.status ?? null };
  }

  async publish(token: string, userId: string, containerId: string): Promise<string> {
    const r = await this.call<{ id: string }>('POST', `/${userId}/media_publish`, token, { creation_id: containerId });
    return r.id;
  }

  async permalink(token: string, mediaId: string): Promise<string | null> {
    const r = await this.call<{ permalink?: string }>('GET', `/${mediaId}`, token, { fields: 'permalink' }).catch(() => ({}) as { permalink?: string });
    return r.permalink ?? null;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, token: string, params: Record<string, string>, versioned = true): Promise<T> {
    const url = `${this.apiBase}${versioned ? `/${this.version}` : ''}${path}`;
    const qs = new URLSearchParams({ ...params, access_token: token });
    let res: Response;
    try {
      res =
        method === 'GET'
          ? await this.fetchFn(`${url}?${qs}`, { signal: AbortSignal.timeout(60_000) })
          : await this.fetchFn(url, { method, body: qs, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new InstagramPublishError('UNAVAILABLE', `Could not reach Instagram: ${(err as Error).name}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as T & GraphError;
    if (!res.ok || body.error) throw this.toError(res.status, body, path.split('/').pop() || 'request');
    return body;
  }

  /** Never includes the URL (it carries the token). */
  private toError(status: number, body: GraphError, what: string): InstagramPublishError {
    const e = body.error ?? {};
    const msg = `Instagram ${what} failed (${status}${e.code ? ` code ${e.code}` : ''}): ${e.message ?? 'unknown error'}`;
    if (e.code === 190 || status === 401) return new InstagramPublishError('AUTH', `${msg}. Reconnect Instagram in Settings.`, false);
    // 4/17/32/613: rate limits; 9 / 2207042: the 24-hour publishing limit.
    if ([4, 17, 32, 613, 9].includes(e.code ?? -1) || e.error_subcode === 2207042 || status === 429) {
      return new InstagramPublishError('RATE_LIMITED', msg, true, 60 * 60_000);
    }
    if (status >= 500 || e.code === 1 || e.code === 2) return new InstagramPublishError('UNAVAILABLE', msg, true);
    return new InstagramPublishError('BAD_REQUEST', msg, false);
  }
}
