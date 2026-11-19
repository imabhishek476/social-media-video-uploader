import type { TranscriptSegment } from './types';

/** Value at quantile q (0..1) of the finite numbers in `values`. */
export function percentile(values: number[], q: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return -60;
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))]!;
}

export interface LoudnessStats {
  median: number;
  p95: number;
}

export const loudnessStats = (loudness: number[]): LoudnessStats => ({ median: percentile(loudness, 0.5), p95: percentile(loudness, 0.95) });

/** Loudest second in [start, end). */
export function peakLoudness(loudness: number[], start: number, end: number): number {
  let peak = -Infinity;
  for (let s = Math.max(0, Math.floor(start)); s < Math.min(loudness.length, Math.ceil(end)); s++) peak = Math.max(peak, loudness[s]!);
  return Number.isFinite(peak) ? peak : -60;
}

/**
 * 0–100 audio-excitement score for a time range: how far its loud moments sit
 * above the stream's typical level (median → 0, the stream's p95 and above → 100).
 */
export function audioScore(loudness: number[], start: number, end: number, stats: LoudnessStats): number {
  const slice = loudness.slice(Math.max(0, Math.floor(start)), Math.ceil(end)).filter(Number.isFinite);
  if (!slice.length) return 0;
  const top = percentile(slice, 0.8);
  const span = Math.max(3, stats.p95 - stats.median);
  return Math.round(Math.max(0, Math.min(100, ((top - stats.median) / span) * 100)));
}

const EXCITED = /\b(no way|let'?s go|oh my god|omg|insane|what\?|holy|clutch|wow|crazy|yes+|oh no|wtf|unbelievable|i can'?t believe)\b|!/gi;

/** Rough count of excited phrases/exclamations in the segments overlapping [start, end). */
export function excitementHits(segments: TranscriptSegment[], start: number, end: number): number {
  let n = 0;
  for (const s of segments) if (s.endSeconds > start && s.startSeconds < end) n += s.text.match(EXCITED)?.length ?? 0;
  return n;
}
