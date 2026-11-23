import { HighlightOutput, SYSTEM_PROMPT, buildHighlightPrompt, mapHighlightOutput } from './highlights';
import { AiProviderError, type HighlightAnalyzer, type HighlightRequest, type HighlightResponse } from './types';

const score = (description: string) => ({ type: 'INTEGER', description });

/** Gemini's OpenAPI-subset schema mirroring `HighlightOutput`. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    highlights: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start_seconds: { type: 'NUMBER', description: 'Clip start, absolute seconds from stream start' },
          end_seconds: { type: 'NUMBER', description: 'Clip end, absolute seconds from stream start' },
          key_moment_seconds: { type: 'NUMBER', description: 'The single best moment (the payoff) inside the clip' },
          hook: { type: 'STRING', description: 'On-screen hook shown on the video: 2-6 punchy words a scroller instantly gets, e.g. HE GOT ME, 1 VS 3, CHAT WAS RIGHT, NO WAY THAT WORKED. What was said at the moment, or the name of what happened. No hashtags, no emoji' },
          reason: { type: 'STRING', description: 'One or two sentences: why this works as a standalone Short' },
          topic: { type: 'STRING', description: '2-4 word topic label' },
          hook_score: score('0-100: do the first 3 seconds grab attention?'),
          emotion_score: score('0-100: strength of emotion (hype, shock, laughter, rage)'),
          entertainment_score: score('0-100: is it funny, impressive or surprising?'),
          context_score: score('0-100: understandable without having watched the stream?'),
          payoff_score: score('0-100: is there a clear payoff or punchline?'),
          clarity_score: score('0-100: clear speech, little dead air or off-topic chatter'),
          overall_score: score('0-100 overall Short potential'),
        },
        required: [
          'start_seconds', 'end_seconds', 'key_moment_seconds', 'hook', 'reason', 'topic',
          'hook_score', 'emotion_score', 'entertainment_score', 'context_score', 'payoff_score', 'clarity_score', 'overall_score',
        ],
      },
    },
  },
  required: ['highlights'],
};

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string; status?: string };
}

/**
 * Highlight selection with Google Gemini (REST `generateContent` with a
 * response schema). Same prompt and output contract as the Claude analyzer.
 */
export class GeminiHighlightAnalyzer implements HighlightAnalyzer {
  readonly name: string;

  constructor(
    private readonly opts: { apiKey: string; model: string; baseUrl?: string; inputPricePerM?: number; outputPricePerM?: number; timeoutMs?: number },
  ) {
    this.name = `gemini:${opts.model}`;
  }

  async analyze(req: HighlightRequest): Promise<HighlightResponse> {
    const base = (this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/models/${encodeURIComponent(this.opts.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: buildHighlightPrompt(req) }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, maxOutputTokens: 16000 },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5 * 60 * 1000),
      });
    } catch (err) {
      throw new AiProviderError('UNAVAILABLE', `Could not reach the Gemini API: ${(err as Error).message}`, true);
    }

    const data = (await res.json().catch(() => ({}))) as GeminiResponse;
    if (!res.ok) {
      const msg = (data.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new AiProviderError('AUTH', `Gemini API rejected the key: ${msg}. Check GEMINI_API_KEY.`, false);
      if (res.status === 429) throw new AiProviderError('RATE_LIMITED', `Gemini rate limit or free-tier quota reached: ${msg}`, true);
      if (res.status >= 500) throw new AiProviderError('UNAVAILABLE', `Gemini API error ${res.status}: ${msg}`, true);
      throw new AiProviderError('BAD_REQUEST', `Gemini API rejected the request: ${msg}`, false);
    }

    if (data.promptFeedback?.blockReason) throw new AiProviderError('REFUSED', `Gemini blocked the transcript (${data.promptFeedback.blockReason})`, false);
    const cand = data.candidates?.[0];
    const finish = cand?.finishReason ?? 'STOP';
    if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION', 'SPII'].includes(finish)) {
      throw new AiProviderError('REFUSED', `Gemini declined to analyse this transcript (${finish})`, false);
    }
    if (finish === 'MAX_TOKENS') throw new AiProviderError('BAD_RESPONSE', 'Gemini output was cut off (max tokens)', true);

    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    let parsed;
    try {
      parsed = HighlightOutput.parse(JSON.parse(text));
    } catch (err) {
      throw new AiProviderError('BAD_RESPONSE', `Gemini returned invalid JSON: ${(err as Error).message.slice(0, 200)}`, true);
    }

    const u = data.usageMetadata ?? {};
    const costUsd =
      ((u.promptTokenCount ?? 0) * (this.opts.inputPricePerM ?? 0) + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * (this.opts.outputPricePerM ?? 0)) / 1_000_000;
    return { highlights: mapHighlightOutput(parsed), costUsd };
  }
}
