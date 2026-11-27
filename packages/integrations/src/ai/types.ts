/**
 * Provider contracts for Phase 4 (spec §8 provider abstraction). The pipeline
 * only depends on these interfaces, so speech-to-text and LLM vendors can be
 * swapped by configuration.
 */

export interface TranscriptWord {
  word: string;
  startSeconds: number;
  endSeconds: number;
}

export interface TranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence?: number | null;
  /** Exact per-word timing when the provider returns it (used for captions). */
  words?: TranscriptWord[];
}

export interface TranscriptionOutput {
  language: string;
  segments: TranscriptSegment[];
}

/** Transcribes one audio file (already split by the pipeline to fit provider limits). */
export interface TranscriptionProvider {
  readonly name: string;
  /** Max upload size the provider accepts, so the pipeline can size audio chunks. */
  readonly maxFileBytes: number;
  /** USD per audio minute, used for the session cost estimate. */
  readonly costPerMinuteUsd: number;
  transcribe(audioPath: string, opts: { language?: string; durationSeconds: number }): Promise<TranscriptionOutput>;
}

export interface ScoreBreakdown {
  hook: number;
  emotion: number;
  entertainment: number;
  context: number;
  payoff: number;
  clarity: number;
  audio?: number;
  chat?: number;
}

/** A highlight exactly as the analyzer proposed it (validated later by the pipeline). */
export interface RawHighlight {
  startSeconds: number;
  endSeconds: number;
  keyMomentSeconds: number | null;
  score: number;
  breakdown: ScoreBreakdown;
  hook: string;
  /** Our channel's own reaction line, shown as a sticker (originality layer). */
  reaction?: string | null;
  /** Question for viewers, posted as the first comment. */
  commentQuestion?: string | null;
  reason: string;
  topic: string | null;
}

export interface HighlightRequest {
  streamTitle: string;
  streamerName: string;
  /** The part of the stream this call covers (long streams are analysed in windows). */
  windowStartSeconds: number;
  windowEndSeconds: number;
  /** Segments inside the window, absolute timestamps. */
  segments: TranscriptSegment[];
  /** Whole-stream loudness, one dBFS value per second (index = second). */
  loudness: number[];
  /** Live-chat messages per 10 s bucket (index × 10 = second); empty when chat wasn't sampled. */
  chat?: number[];
  /** Game being played, when known (from the streamer's setting or the stream title). */
  game?: { name: string; hashtags: string[] } | null;
  clip: { minSeconds: number; maxSeconds: number; targetSeconds: number };
  maxCandidates: number;
}

export interface HighlightResponse {
  highlights: RawHighlight[];
  costUsd: number;
}

export interface HighlightAnalyzer {
  readonly name: string;
  analyze(req: HighlightRequest): Promise<HighlightResponse>;
}

/** Errors from AI providers. `retryable` ones (rate limits, outages) are retried by the queue. */
export class AiProviderError extends Error {
  constructor(
    public readonly code: 'AUTH' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'BAD_REQUEST' | 'REFUSED' | 'BAD_RESPONSE',
    message: string,
    public readonly retryable: boolean,
    /** When the provider says how long to wait (rate limits). */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export const formatTimestamp = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
