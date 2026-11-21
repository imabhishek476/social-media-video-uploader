import fsp from 'node:fs/promises';
import path from 'node:path';
import { AiProviderError, type TranscriptionOutput, type TranscriptionProvider } from './types';

/**
 * Whisper-style speech-to-text over the OpenAI-compatible
 * `/audio/transcriptions` endpoint. Works with OpenAI (`whisper-1`) and other
 * vendors that expose the same API (for example Groq `whisper-large-v3-turbo`)
 * by changing the base URL and model.
 */
export class OpenAiCompatibleTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'openai';
  readonly maxFileBytes = 24 * 1024 * 1024; // provider limit is 25 MB
  readonly costPerMinuteUsd: number;

  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; model: string; costPerMinuteUsd: number; timeoutMs?: number },
  ) {
    this.costPerMinuteUsd = opts.costPerMinuteUsd;
  }

  async transcribe(audioPath: string, { language }: { language?: string; durationSeconds: number }): Promise<TranscriptionOutput> {
    const form = new FormData();
    form.append('file', new Blob([await fsp.readFile(audioPath)]), path.basename(audioPath));
    form.append('model', this.opts.model);
    form.append('response_format', 'verbose_json');
    // Word timing drives the caption highlight; segments drive analysis.
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');
    if (language) form.append('language', language);

    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10 * 60 * 1000),
      });
    } catch (err) {
      throw new AiProviderError('UNAVAILABLE', `Transcription request failed: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new AiProviderError('AUTH', `Transcription API rejected the key (${res.status}). Check TRANSCRIPTION_API_KEY.`, false);
      if (res.status === 429) throw new AiProviderError('RATE_LIMITED', 'Transcription API rate limit reached', true);
      if (res.status >= 500) throw new AiProviderError('UNAVAILABLE', `Transcription API error ${res.status}`, true);
      throw new AiProviderError('BAD_REQUEST', `Transcription API error ${res.status}: ${body}`, false);
    }
    const data = (await res.json()) as {
      language?: string;
      segments?: Array<{ start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number }>;
      words?: Array<{ word: string; start: number; end: number }>;
    };
    const words = (data.words ?? []).filter((w) => w.word?.trim()).map((w) => ({ word: w.word.trim(), startSeconds: w.start, endSeconds: w.end }));
    const segments = (data.segments ?? [])
      .filter((s) => s.text?.trim() && (s.no_speech_prob ?? 0) < 0.8)
      .map((s) => ({
        startSeconds: s.start,
        endSeconds: s.end,
        text: s.text.trim(),
        confidence: typeof s.avg_logprob === 'number' ? Math.round(Math.exp(s.avg_logprob) * 1000) / 1000 : null,
        ...(words.length ? { words: wordsWithin(words, s.start, s.end) } : {}),
      }));
    return { language: data.language ?? language ?? 'en', segments };
  }
}

/** Words whose midpoint falls inside [start, end). Each word belongs to exactly one segment. */
export function wordsWithin<W extends { startSeconds: number; endSeconds: number }>(words: W[], start: number, end: number): W[] {
  return words.filter((w) => {
    const mid = (w.startSeconds + w.endSeconds) / 2;
    return mid >= start && mid < end;
  });
}
