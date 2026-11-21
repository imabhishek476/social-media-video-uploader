import type { RawHighlight, TranscriptSegment } from '@shorts/integrations';

export interface ClipBounds {
  minSeconds: number;
  maxSeconds: number;
  /** Length of the source; clips never extend past it. */
  sourceSeconds: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Timestamp validation (spec §7): clamp a model-proposed range to the source,
 * force it into the allowed clip length around the key moment, and snap the
 * edges to sentence boundaries so clips don't start or end mid-word.
 * Returns null for ranges that can't be repaired.
 */
export function normalizeHighlight(raw: RawHighlight, bounds: ClipBounds, segments: TranscriptSegment[]): RawHighlight | null {
  const { minSeconds, maxSeconds, sourceSeconds } = bounds;
  if (![raw.startSeconds, raw.endSeconds].every(Number.isFinite) || sourceSeconds < minSeconds) return null;
  let start = clamp(raw.startSeconds, 0, sourceSeconds);
  let end = clamp(raw.endSeconds, 0, sourceSeconds);
  if (end - start < 1) return null;
  const key = clamp(Number.isFinite(raw.keyMomentSeconds ?? NaN) ? raw.keyMomentSeconds! : (start + end) / 2, start, end);

  if (end - start < minSeconds) {
    const missing = minSeconds - (end - start);
    start = Math.max(0, start - missing / 2);
    end = Math.min(sourceSeconds, start + minSeconds);
    start = Math.max(0, end - minSeconds);
  } else if (end - start > maxSeconds) {
    // Keep the key moment, with a little more lead-in than tail.
    start = clamp(key - maxSeconds * 0.6, start, end - maxSeconds);
    end = start + maxSeconds;
  }

  // Snap to segment boundaries when that keeps the length legal.
  const snapStart = segments.filter((s) => s.startSeconds >= start - 2 && s.startSeconds <= start + 1.5).sort((a, b) => Math.abs(a.startSeconds - start) - Math.abs(b.startSeconds - start))[0];
  const snapEnd = segments.filter((s) => s.endSeconds >= end - 1.5 && s.endSeconds <= end + 2).sort((a, b) => Math.abs(a.endSeconds - end) - Math.abs(b.endSeconds - end))[0];
  const s2 = snapStart ? Math.max(0, snapStart.startSeconds - 0.2) : start;
  const e2 = snapEnd ? Math.min(sourceSeconds, snapEnd.endSeconds + 0.3) : end;
  if (e2 - s2 >= minSeconds && e2 - s2 <= maxSeconds) {
    start = s2;
    end = e2;
  }

  return {
    ...raw,
    startSeconds: round1(start),
    endSeconds: round1(end),
    keyMomentSeconds: round1(clamp(key, start, end)),
    score: Math.round(clamp(raw.score, 0, 100)),
  };
}

/**
 * De-duplicate overlapping candidates (spec §7 "merge and de-dup"). Strongly
 * overlapping ranges merge when the union still fits the max length; otherwise
 * the higher-scoring one wins.
 */
export function mergeHighlights(list: RawHighlight[], maxSeconds: number): RawHighlight[] {
  const accepted: RawHighlight[] = [];
  for (const c of [...list].sort((a, b) => b.score - a.score)) {
    const hit = accepted.findIndex((a) => Math.min(a.endSeconds, c.endSeconds) - Math.max(a.startSeconds, c.startSeconds) > 0);
    if (hit === -1) {
      accepted.push(c);
      continue;
    }
    const a = accepted[hit]!;
    const overlap = Math.min(a.endSeconds, c.endSeconds) - Math.max(a.startSeconds, c.startSeconds);
    const unionStart = Math.min(a.startSeconds, c.startSeconds);
    const unionEnd = Math.max(a.endSeconds, c.endSeconds);
    const shorter = Math.min(a.endSeconds - a.startSeconds, c.endSeconds - c.startSeconds);
    if (overlap >= shorter * 0.5 && unionEnd - unionStart <= maxSeconds) {
      accepted[hit] = { ...a, startSeconds: unionStart, endSeconds: unionEnd };
    }
    // else: drop the lower-scoring duplicate
  }
  return accepted;
}

/** Final score: the analyzer's judgement, nudged by the audio signal. */
export const blendScore = (modelScore: number, audio: number, audioWeight: number) => Math.round(modelScore * (1 - audioWeight) + audio * audioWeight);

/** Final score with live-chat activity as an extra signal (when chat was sampled). */
export function blendSignals(modelScore: number, signals: { audio: number; audioWeight: number; chat?: number | null; chatWeight?: number }): number {
  const cw = signals.chat == null ? 0 : (signals.chatWeight ?? 0);
  return Math.round(modelScore * (1 - signals.audioWeight - cw) + signals.audio * signals.audioWeight + (signals.chat ?? 0) * cw);
}
