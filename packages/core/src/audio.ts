import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { probeMedia } from './ffprobe';

const execFileAsync = promisify(execFile);

export interface AudioChunk {
  path: string;
  offsetSeconds: number;
  durationSeconds: number;
}

/** Bitrate of the speech-only MP3 we send to transcription (mono 16 kHz is plenty for speech). */
const SPEECH_BITRATE_KBPS = 32;

/**
 * Extract the audio track as speech-optimised MP3 pieces small enough for the
 * transcription provider. Offsets come from the real piece durations, so
 * transcript timestamps stay aligned with the source video.
 */
export async function extractAudioChunks(sourcePath: string, outDir: string, maxFileBytes: number, maxChunkSeconds = 20 * 60): Promise<AudioChunk[]> {
  await fsp.mkdir(outDir, { recursive: true });
  // 10% headroom for MP3 framing overhead.
  const bySize = Math.floor((maxFileBytes * 0.9) / ((SPEECH_BITRATE_KBPS * 1000) / 8));
  const chunkSeconds = Math.min(maxChunkSeconds, Math.max(60, bySize));
  await execFileAsync(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', `${SPEECH_BITRATE_KBPS}k`, '-f', 'segment', '-segment_time', String(chunkSeconds), '-reset_timestamps', '1', path.join(outDir, 'chunk_%04d.mp3')],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const files = (await fsp.readdir(outDir)).filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort();
  const chunks: AudioChunk[] = [];
  let offset = 0;
  for (const f of files) {
    const p = path.join(outDir, f);
    const { durationSeconds } = await probeMedia(p).catch(() => ({ durationSeconds: 0 }));
    if (durationSeconds > 0.5) chunks.push({ path: p, offsetSeconds: offset, durationSeconds });
    offset += durationSeconds;
  }
  return chunks;
}

/**
 * Loudness profile: RMS level (dBFS) for each second of audio. Cheap signal
 * for reactions (shouting, laughter, hype) used in highlight scoring.
 */
export async function measureLoudness(sourcePath: string): Promise<number[]> {
  const filter = 'aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-';
  const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', sourcePath, '-vn', '-ac', '1', '-af', filter, '-f', 'null', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const values: number[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/RMS_level=(-?[\d.]+|-inf|inf|nan)/);
    if (!m) continue;
    const v = Number(m[1]);
    values.push(Number.isFinite(v) ? Math.round(Math.max(-90, v) * 10) / 10 : -90);
  }
  return values;
}
