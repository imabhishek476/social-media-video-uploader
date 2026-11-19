import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MediaInfo {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  sizeBytes: number;
}

interface ProbeOutput {
  format?: { duration?: string; size?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }>;
}

export class MediaProbeError extends Error {
  constructor(
    public readonly code: 'FFPROBE_MISSING' | 'CORRUPT_MEDIA',
    message: string,
  ) {
    super(message);
    this.name = 'MediaProbeError';
  }
}

const parseRate = (r?: string) => {
  if (!r) return null;
  const [n, d] = r.split('/').map(Number);
  return n && d ? Math.round((n / d) * 100) / 100 : null;
};

/** Inspect a media file with FFprobe (spec §6 Workflow D step 4). */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaProbeError('FFPROBE_MISSING', 'ffprobe is not installed on this worker');
    throw new MediaProbeError('CORRUPT_MEDIA', 'File is not readable media (corrupt, truncated or unsupported)');
  }
  const out = JSON.parse(stdout) as ProbeOutput;
  const video = out.streams?.find((s) => s.codec_type === 'video');
  const audio = out.streams?.find((s) => s.codec_type === 'audio');
  const duration = Number(out.format?.duration ?? video?.duration ?? 0);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: video?.width ?? null,
    height: video?.height ?? null,
    frameRate: parseRate(video?.avg_frame_rate),
    videoCodec: video?.codec_name ?? null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    sizeBytes: Number(out.format?.size ?? 0),
  };
}

export interface SourceLimits {
  maxDurationMinutes: number;
  maxFileSizeMb: number;
}

/** Returns a human-readable problem, or null when the file is usable. */
export function validateMedia(info: MediaInfo, limits: SourceLimits): string | null {
  if (!info.hasVideo) return 'The file has no video stream';
  if (!info.hasAudio) return 'The file has no audio stream, so it cannot be transcribed';
  if (info.durationSeconds < 10) return 'The file is shorter than 10 seconds';
  if (info.durationSeconds > limits.maxDurationMinutes * 60) {
    return `The recording is ${Math.round(info.durationSeconds / 60)} min, over the ${limits.maxDurationMinutes} min limit (Settings → Processing)`;
  }
  if (info.sizeBytes > limits.maxFileSizeMb * 1024 * 1024) {
    return `The file is ${Math.round(info.sizeBytes / 1024 / 1024)} MB, over the ${limits.maxFileSizeMb} MB limit (Settings → Processing)`;
  }
  return null;
}
