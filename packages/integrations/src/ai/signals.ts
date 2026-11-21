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

/** Live-chat activity is stored as message counts per bucket of this many seconds. */
export const CHAT_BUCKET_SECONDS = 10;
/** Chat reacts after the moment: look this far past a range's end. */
export const CHAT_LAG_SECONDS = 20;

export interface ChatStats {
  median: number;
  p95: number;
}

export function chatStats(counts: number[]): ChatStats {
  const v = counts.map((n) => n || 0);
  if (!v.length) return { median: 0, p95: 0 };
  const sorted = [...v].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!;
  return { median: at(0.5), p95: at(0.95) };
}

/** Busiest chat bucket for a time range (including the lag after it). */
export function peakChat(counts: number[], start: number, end: number): number {
  let peak = 0;
  const from = Math.max(0, Math.floor(start / CHAT_BUCKET_SECONDS));
  const to = Math.min(counts.length, Math.ceil((end + CHAT_LAG_SECONDS) / CHAT_BUCKET_SECONDS));
  for (let i = from; i < to; i++) peak = Math.max(peak, counts[i] || 0);
  return peak;
}

/**
 * 0–100 chat-spike score: how far chat activity during (and just after) a
 * range rises above the stream's usual rate (median → 0, p95 and above → 100).
 */
export function chatScore(counts: number[], start: number, end: number, stats: ChatStats): number {
  if (!counts.length) return 0;
  const peak = peakChat(counts, start, end);
  const span = Math.max(2, stats.p95 - stats.median);
  return Math.round(Math.max(0, Math.min(100, ((peak - stats.median) / span) * 100)));
}
