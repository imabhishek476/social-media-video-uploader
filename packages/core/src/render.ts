import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';

export type RenderMode = 'CENTER_CROP' | 'BLUR_FIT' | 'FACECAM_SPLIT' | 'GAMEPLAY';

/** Normalised rectangle (0–1 of the source frame). */
export interface FrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Facecam band height in the split layout (gameplay gets the rest). */
export const FACECAM_BAND = 900;
/** White line between webcam and gameplay in the split layout. */
const DIVIDER = 8;

/**
 * Where the caption line sits (px from the top of 1920), so it never covers
 * the middle of the gameplay: on the webcam/gameplay seam for the split
 * layout, in the lower third (above the Shorts UI) for full-screen gameplay.
 * null = use the caption position from Settings.
 */
export function captionAnchor(mode: RenderMode, position: 'TOP' | 'MIDDLE' | 'BOTTOM'): number | null {
  if (mode === 'FACECAM_SPLIT') return FACECAM_BAND - 24;
  if (position === 'TOP') return null;
  if (mode === 'GAMEPLAY' || mode === 'CENTER_CROP') return 1430;
  return null;
}

export interface RenderSpec {
  sourcePath: string;
  outPath: string;
  thumbnailPath: string;
  /** ASS caption file (times relative to the clip start), or null for no captions. */
  captionsPath: string | null;
  startSeconds: number;
  endSeconds: number;
  /** Absolute time of the best moment, used for the thumbnail. */
  keyMomentSeconds: number | null;
  mode: RenderMode;
  /** Required for FACECAM_SPLIT. */
  facecam?: FrameBox | null;
  /** Extra fonts for the captions (bundled caption fonts). */
  fontsDir?: string | null;
}

export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;
const FPS = 30;

/** Escape a path for use inside an FFmpeg filter argument. */
export const filterPath = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');

/** Video filter graph producing `[v]` at 1080×1920. */
export function videoFilter(mode: RenderMode, captionsPath: string | null, facecam?: FrameBox | null, fontsDir?: string | null): string {
  const W = SHORT_WIDTH;
  const H = SHORT_HEIGHT;
  const captions = captionsPath ? `,ass=filename=${filterPath(captionsPath)}${fontsDir ? `:fontsdir=${filterPath(fontsDir)}` : ''}` : '';
  if (mode === 'FACECAM_SPLIT' && facecam) {
    // Facecam (cropped to fill the top band) stacked over a centre crop of the gameplay.
    const f = (n: number) => n.toFixed(4);
    const top = FACECAM_BAND;
    const bottom = H - top;
    return [
      '[0:v]split=2[camsrc][gamesrc]',
      `[camsrc]crop=w=iw*${f(facecam.w)}:h=ih*${f(facecam.h)}:x=iw*${f(facecam.x)}:y=ih*${f(facecam.y)},scale=${W}:${top}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${top}[cam]`,
      `[gamesrc]crop=w='min(iw,ih*${W}/${bottom})':h='min(ih,iw*${bottom}/${W})',scale=${W}:${bottom}:flags=lanczos[game]`,
      `[cam][game]vstack=inputs=2,drawbox=x=0:y=${top - DIVIDER / 2}:w=${W}:h=${DIVIDER}:color=white@0.95:t=fill,setsar=1,fps=${FPS}${captions},format=yuv420p[v]`,
    ].join(';');
  }
  if (mode === 'GAMEPLAY' && facecam) {
    // Game centre-cropped to fill 9:16; the webcam (with a neon border) sits in the top-left,
    // below the hook box and clear of the Shorts UI.
    const f = (n: number) => n.toFixed(4);
    const camW = 420;
    return [
      '[0:v]split=2[camsrc][gamesrc]',
      `[gamesrc]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=${W}:${H}:flags=lanczos[game]`,
      `[camsrc]crop=w=iw*${f(facecam.w)}:h=ih*${f(facecam.h)}:x=iw*${f(facecam.x)}:y=ih*${f(facecam.y)},scale=${camW}:-2:flags=lanczos,pad=iw+12:ih+12:6:6:color=0x22F0FF[cam]`,
      `[game][cam]overlay=40:470,setsar=1,fps=${FPS}${captions},format=yuv420p[v]`,
    ].join(';');
  }
  if (mode === 'BLUR_FIT') {
    return [
      '[0:v]split=2[bgsrc][fgsrc]',
      `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40,eq=brightness=-0.12[bg]`,
      `[fgsrc]scale=${W}:-2[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS}${captions},format=yuv420p[v]`,
    ].join(';');
  }
  // Centre crop to 9:16 (works for any source aspect ratio), then scale up.
  return `[0:v]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=${W}:${H}:flags=lanczos,setsar=1,fps=${FPS}${captions},format=yuv420p[v]`;
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

function runFfmpeg(args: string[], durationSeconds: number, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    proc.stdout.on('data', (d: Buffer) => {
      const m = d.toString().match(/out_time_us=(\d+)/g);
      if (m && onProgress) onProgress(Math.min(1, Number(m[m.length - 1]!.split('=')[1]) / 1e6 / durationSeconds));
    });
    proc.on('error', (err) => reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new RenderError('ffmpeg is not installed on this worker') : err));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new RenderError(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

const LOUDNORM_TARGET = 'I=-14:TP=-1.5:LRA=11';

/**
 * Two-pass EBU R128 normalisation: measure the clip's audio first, then
 * apply exact linear gain. One-pass loudnorm undershoots on short clips.
 * Falls back to one-pass if measuring fails.
 */
export async function loudnormFilter(sourcePath: string, start: number, duration: number): Promise<string> {
  const onePass = `loudnorm=${LOUDNORM_TARGET},aresample=48000`;
  const stderr = await new Promise<string>((resolve) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-ss', start.toFixed(3), '-i', sourcePath, '-t', duration.toFixed(3), '-vn', '-af', `loudnorm=${LOUDNORM_TARGET}:print_format=json`, '-f', 'null', '-']);
    let err = '';
    proc.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-8000)));
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(err));
  });
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1);
  try {
    const m = JSON.parse(json) as Record<string, string>;
    const vals = [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset].map(Number);
    if (vals.some((v) => !Number.isFinite(v))) return onePass; // e.g. silent clip (-inf)
    const [i, tp, lra, thresh, offset] = vals;
    return `loudnorm=${LOUDNORM_TARGET}:measured_I=${i}:measured_TP=${tp}:measured_LRA=${lra}:measured_thresh=${thresh}:offset=${offset}:linear=true,aresample=48000`;
  } catch {
    return onePass;
  }
}

/**
 * Render one vertical Short (spec §9): trim, reframe to 9:16, burn in
 * captions, normalise loudness for mobile (-14 LUFS), encode H.264/AAC with
 * fast-start, then grab a thumbnail at the key moment.
 */
/** Join rendered parts (same encoder settings) into one file without re-encoding. */
export async function concatShorts(parts: string[], outPath: string): Promise<void> {
  const list = `${outPath}.txt`;
  await fsp.writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', outPath], 1);
  } finally {
    await fsp.rm(list, { force: true });
  }
}

/**
 * Cold open: a short flash-forward of the best moment before the clip, so the
 * first second already shows the payoff. Only when there is real build-up
 * (the key moment is 6+ s in) and the payoff isn't at the very end.
 */
export function coldOpenRange(start: number, end: number, keyMoment: number | null | undefined): { start: number; end: number } | null {
  if (keyMoment == null || keyMoment - start < 6 || end - keyMoment < 1) return null;
  return { start: Math.max(start, keyMoment - 0.4), end: Math.min(end, keyMoment + 1.6) };
}

export async function renderShort(spec: RenderSpec, onProgress?: (fraction: number) => void): Promise<{ durationSeconds: number; sizeBytes: number }> {
  const duration = Math.max(0.5, spec.endSeconds - spec.startSeconds);
  const audioFilter = await loudnormFilter(spec.sourcePath, spec.startSeconds, duration);
  await runFfmpeg(
    [
      '-y',
      '-ss', spec.startSeconds.toFixed(3),
      '-i', spec.sourcePath,
      '-t', duration.toFixed(3),
      '-filter_complex', videoFilter(spec.mode, spec.captionsPath, spec.facecam, spec.fontsDir),
      '-map', '[v]',
      '-map', '0:a:0?',
      '-af', audioFilter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level', '4.1',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-movflags', '+faststart',
      '-shortest',
      spec.outPath,
    ],
    duration,
    onProgress,
  );
  const thumbAt = Math.min(Math.max(0, (spec.keyMomentSeconds ?? spec.startSeconds + duration / 3) - spec.startSeconds), duration - 0.1);
  await runFfmpeg(['-y', '-ss', thumbAt.toFixed(2), '-i', spec.outPath, '-frames:v', '1', '-q:v', '3', spec.thumbnailPath], 1);
  const { size } = await fsp.stat(spec.outPath);
  return { durationSeconds: Math.round(duration * 10) / 10, sizeBytes: size };
}

/** Grab JPEG frames at the given times (seconds) for facecam detection. */
export async function extractFrames(sourcePath: string, times: number[], outDir: string): Promise<string[]> {
  await fsp.mkdir(outDir, { recursive: true });
  const out: string[] = [];
  for (const [i, t] of times.entries()) {
    const file = `${outDir}/frame-${i}.jpg`;
    await runFfmpeg(['-y', '-ss', t.toFixed(2), '-i', sourcePath, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', file], 1);
    out.push(file);
  }
  return out;
}

/**
 * Long-form compilation (16:9, 1920×1080) from vertical Shorts: each Short is
 * centred over a blurred, zoomed copy of itself, then all are joined in order.
 */
export async function renderCompilation(inputs: string[], outPath: string, totalSeconds: number, onProgress?: (fraction: number) => void): Promise<void> {
  if (!inputs.length) throw new RenderError('No clips to compile');
  const parts = inputs.map(
    (_, i) =>
      `[${i}:v]split=2[b${i}][f${i}];` +
      `[b${i}]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=30,eq=brightness=-0.15[bg${i}];` +
      `[f${i}]scale=-2:1080:flags=lanczos[fg${i}];` +
      `[bg${i}][fg${i}]overlay=(W-w)/2:0,setsar=1,fps=${FPS},format=yuv420p[v${i}];` +
      `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`,
  );
  const concat = `${inputs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${inputs.length}:v=1:a=1[v][a]`;
  await runFfmpeg(
    [
      '-y',
      ...inputs.flatMap((p) => ['-i', p]),
      '-filter_complex', `${parts.join(';')};${concat}`,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-profile:v', 'high',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      outPath,
    ],
    totalSeconds,
    onProgress,
  );
}

/** "M:SS" (or "H:MM:SS") chapter stamp. */
export function chapterStamp(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
