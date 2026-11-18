import type { ChannelRef } from './types';

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE_RE = /^@[A-Za-z0-9._-]{3,30}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

export const isChannelId = (v: string) => CHANNEL_ID_RE.test(v);

/**
 * Normalise anything an admin might paste — channel URL, @handle, channel ID,
 * legacy /user/ or /c/ URL, or a video/live URL — into a ChannelRef.
 * Returns null for anything that isn't a YouTube reference (spec §17:
 * validate external URLs; we never fetch arbitrary hosts).
 */
export function parseChannelInput(raw: string): ChannelRef | null {
  const input = raw.trim();
  if (!input) return null;
  if (CHANNEL_ID_RE.test(input)) return { kind: 'id', value: input };
  if (HANDLE_RE.test(input)) return { kind: 'handle', value: input };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return VIDEO_ID_RE.test(id) ? { kind: 'video', value: id } : null;
  }
  if (!YT_HOSTS.has(host)) return null;

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [first, second] = parts;

  if (first === 'watch') {
    const v = url.searchParams.get('v') ?? '';
    return VIDEO_ID_RE.test(v) ? { kind: 'video', value: v } : null;
  }
  if ((first === 'live' || first === 'shorts' || first === 'embed') && second && VIDEO_ID_RE.test(second)) {
    return { kind: 'video', value: second };
  }
  if (first === 'channel' && second && CHANNEL_ID_RE.test(second)) return { kind: 'id', value: second };
  if (first?.startsWith('@') && HANDLE_RE.test(first)) return { kind: 'handle', value: first };
  if (first === 'user' && second) return { kind: 'username', value: second };
  if (first === 'c' && second) return { kind: 'custom', value: second };
  return null;
}

export const channelUrlFor = (channelId: string, handle: string | null) =>
  handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${channelId}`;

export const videoUrlFor = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;
