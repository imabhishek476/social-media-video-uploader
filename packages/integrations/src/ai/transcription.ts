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
    form.append('timestamp_granularities[]', 'segment');
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
    };
    const segments = (data.segments ?? [])
      .filter((s) => s.text?.trim() && (s.no_speech_prob ?? 0) < 0.8)
      .map((s) => ({
        startSeconds: s.start,
        endSeconds: s.end,
        text: s.text.trim(),
        confidence: typeof s.avg_logprob === 'number' ? Math.round(Math.exp(s.avg_logprob) * 1000) / 1000 : null,
      }));
    return { language: data.language ?? language ?? 'en', segments };
  }
}

const MOCK_LINES = [
  'okay chat let us go, this is the plan',
  'wait wait wait, what is happening right now',
  'no way! that was insane, did you see that?',
  'alright, let me explain what we are doing here',
  'thank you so much for the subs everyone',
  'oh my god, we actually did it, let us go!',
  'this is so funny, I cannot stop laughing',
  'okay focus, focus, this is the important part',
];

/**
 * Offline stand-in for development and tests: deterministic placeholder text
 * every 6 seconds. Highlight quality with it comes from the audio signal only.
 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'mock';
  readonly maxFileBytes = Number.MAX_SAFE_INTEGER;
  readonly costPerMinuteUsd = 0;

  async transcribe(_audioPath: string, { language, durationSeconds }: { language?: string; durationSeconds: number }): Promise<TranscriptionOutput> {
    const segments = [];
    for (let t = 0, i = 0; t < durationSeconds; t += 6, i++) {
      segments.push({ startSeconds: t, endSeconds: Math.min(durationSeconds, t + 5.5), text: MOCK_LINES[i % MOCK_LINES.length]!, confidence: null });
    }
    return { language: language ?? 'en', segments };
  }
}
