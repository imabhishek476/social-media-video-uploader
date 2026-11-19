import fsp from 'node:fs/promises';
import path from 'node:path';

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
        if (stat?.isFile()) return { localPath: candidate, consume: true };
      }
    }
    return null;
  }
}

export function createVideoSourceProvider(name: string, storageDir: string): VideoSourceProvider {
  switch (name) {
    case 'local':
      return new LocalFolderProvider(incomingDir(storageDir));
    default:
      throw new Error(`Unknown video source provider "${name}". Available: local`);
  }
}
