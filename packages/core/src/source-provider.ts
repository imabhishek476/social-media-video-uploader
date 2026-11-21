import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStorage } from '@shorts/integrations';

/**
 * Where a completed stream's recording comes from (spec §1: the channel URL
 * is NOT a media file). Providers only *locate* a local file; the acquisition
 * service validates and stores it. New sources (Drive, S3, OBS push) are new
 * providers — nothing downstream changes.
 */
export interface SourceRef {
  localPath: string;
  /** Delete the local file after it is safely in object storage. */
  consume: boolean;
  /** Where it came from, for messages and logs. */
  origin: string;
  /** Remove the original (e.g. the inbox object) once stored or rejected. */
  release?: () => Promise<void>;
}

export interface VideoSourceProvider {
  readonly name: string;
  locate(session: { id: string; broadcastId: string }): Promise<SourceRef | null>;
}

export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.ts', '.flv'];
export const incomingDir = (storageDir: string) => path.join(storageDir, 'incoming');

/**
 * Watch-folder provider: `<storage>/incoming/<broadcastId>.<ext>` (drop a
 * recording in by hand, rclone, OBS) or `<sessionId>.<ext>` (dashboard upload).
 */
export class LocalFolderProvider implements VideoSourceProvider {
  readonly name = 'local';
  constructor(private readonly dir: string) {}

  async locate(session: { id: string; broadcastId: string }): Promise<SourceRef | null> {
    for (const base of [session.id, session.broadcastId]) {
      for (const ext of VIDEO_EXTENSIONS) {
        const candidate = path.join(this.dir, `${base}${ext}`);
        const stat = await fsp.stat(candidate).catch(() => null);
        if (stat?.isFile()) return { localPath: candidate, consume: true, origin: `incoming/${base}${ext}` };
      }
    }
    return null;
  }
}

/** Prefix in object storage where recordings are dropped (e.g. gs://<bucket>/incoming/). */
export const INBOX_PREFIX = 'incoming';

/** File name stem → { base, ext } for a supported video file, else null. */
export function parseInboxName(name: string): { base: string; ext: string } | null {
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) return null;
  return { base: path.basename(name, ext), ext };
}

/**
 * Storage inbox provider: recordings uploaded to `incoming/<broadcastId>.<ext>`
 * (or `<sessionId>.<ext>`) in the bucket, by the streamer, OBS + rclone/gsutil,
 * or by hand in the Cloud Console. Downloaded for validation; the inbox
 * object is removed once the recording is stored.
 */
export class StorageInboxProvider implements VideoSourceProvider {
  readonly name: string;
  constructor(
    private readonly storage: ObjectStorage,
    private readonly tempDir: string,
  ) {
    this.name = `${storage.name}-inbox`;
  }

  async locate(session: { id: string; broadcastId: string }): Promise<SourceRef | null> {
    const objects = await this.storage.list(INBOX_PREFIX);
    for (const base of [session.id, session.broadcastId]) {
      const hit = objects.find((o) => parseInboxName(path.basename(o.key))?.base === base);
      if (!hit) continue;
      const localPath = path.join(this.tempDir, `inbox-${session.id}${path.extname(hit.key).toLowerCase()}`);
      await this.storage.download(hit.key, localPath);
      return { localPath, consume: true, origin: hit.key, release: () => this.storage.delete(hit.key) };
    }
    return null;
  }
}

/** Tries providers in order (dashboard uploads first, then the bucket inbox). */
export class CompositeSourceProvider implements VideoSourceProvider {
  readonly name: string;
  constructor(private readonly providers: VideoSourceProvider[]) {
    this.name = providers.map((p) => p.name).join('+');
  }
  async locate(session: { id: string; broadcastId: string }): Promise<SourceRef | null> {
    for (const p of this.providers) {
      const ref = await p.locate(session);
      if (ref) return ref;
    }
    return null;
  }
}

/**
 * Downloads the finished stream's VOD with yt-dlp (opt-in: VIDEO_SOURCE_PROVIDER
 * includes `ytdlp`). Only use it for channels whose owners allow clipping.
 * Tried last, so manual uploads and the inbox still win.
 */
export class YtDlpProvider implements VideoSourceProvider {
  readonly name = 'ytdlp';
  constructor(
    private readonly tempDir: string,
    private readonly opts: { binary?: string; maxHeight?: number; timeoutMs?: number } = {},
  ) {}

  async locate(session: { id: string; broadcastId: string }): Promise<SourceRef | null> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(session.broadcastId)) return null;
    await fsp.mkdir(this.tempDir, { recursive: true });
    const out = path.join(this.tempDir, `ytdlp-${session.id}.mp4`);
    await fsp.rm(out, { force: true });
    const h = this.opts.maxHeight ?? 1080;
    const args = [
      '--no-playlist', '--no-progress', '--quiet', '--no-warnings',
      '-f', `bv*[height<=${h}]+ba/b[height<=${h}]`,
      '--merge-output-format', 'mp4',
      '-o', out,
      `https://www.youtube.com/watch?v=${session.broadcastId}`,
    ];
    const stderr = await new Promise<string>((resolve, reject) => {
      const proc = spawn(this.opts.binary ?? 'yt-dlp', args);
      let err = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), this.opts.timeoutMs ?? 6 * 60 * 60_000);
      proc.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('yt-dlp is not installed on this worker (pipx install yt-dlp)') : e);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? '' : err.trim() || `yt-dlp exited with ${code}`);
      });
    });
    const stat = await fsp.stat(out).catch(() => null);
    if (stderr || !stat?.isFile()) {
      // Usually the VOD is still being processed right after the stream ends: let the queue retry.
      throw new Error(`yt-dlp could not download ${session.broadcastId}: ${stderr.split('\n').pop()}`);
    }
    return { localPath: out, consume: true, origin: `youtube:${session.broadcastId}` };
  }
}

export function createVideoSourceProvider(storageDir: string, storage: ObjectStorage, providerSetting = 'local', ytdlpBinary = 'yt-dlp'): VideoSourceProvider {
  const tmp = path.join(storageDir, 'tmp');
  const providers: VideoSourceProvider[] = [new LocalFolderProvider(incomingDir(storageDir)), new StorageInboxProvider(storage, tmp)];
  if (providerSetting.split(',').map((p) => p.trim()).includes('ytdlp')) providers.push(new YtDlpProvider(tmp, { binary: ytdlpBinary }));
  return new CompositeSourceProvider(providers);
}
