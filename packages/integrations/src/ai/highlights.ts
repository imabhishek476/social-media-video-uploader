import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { audioScore, excitementHits, loudnessStats, peakLoudness } from './signals';
import { AiProviderError, formatTimestamp, type HighlightAnalyzer, type HighlightRequest, type HighlightResponse, type RawHighlight } from './types';

export const HighlightOutput = z.object({
  highlights: z.array(
    z.object({
      start_seconds: z.number().describe('Clip start, absolute seconds from stream start'),
      end_seconds: z.number().describe('Clip end, absolute seconds from stream start'),
      key_moment_seconds: z.number().describe('The single best moment (the payoff) inside the clip'),
      hook: z.string().describe('Short on-screen hook for the first seconds of the Short, max 60 characters'),
      reason: z.string().describe('One or two sentences: why this works as a standalone Short'),
      topic: z.string().describe('2-4 word topic label'),
      hook_score: z.number().describe('0-100: do the first 3 seconds grab attention?'),
      emotion_score: z.number().describe('0-100: strength of emotion (hype, shock, laughter, rage)'),
      entertainment_score: z.number().describe('0-100: is it funny, impressive or surprising?'),
      context_score: z.number().describe('0-100: understandable without having watched the stream?'),
      payoff_score: z.number().describe('0-100: is there a clear payoff or punchline?'),
      clarity_score: z.number().describe('0-100: clear speech, little dead air or off-topic chatter'),
      overall_score: z.number().describe('0-100 overall Short potential'),
    }),
  ),
});

export const SYSTEM_PROMPT = `You are a senior short-form video editor who finds the moments in livestream recordings that will perform best as standalone YouTube Shorts (vertical, under a minute).

You get a timestamped transcript of part of a stream. Each line is "[<absolute seconds>s | <clock>] text", and lines where the audio is much louder than the stream's usual level are tagged (LOUD +N dB). Loudness spikes often mark reactions (screaming, laughing, hype), so weigh them, but a quiet funny line can still be a great clip.

Pick moments that:
- work without context from the rest of the stream,
- open with a hook in the first 2-3 seconds (start shortly before the setup, not in the middle of an unrelated sentence),
- end right after the payoff or punchline, without trailing chatter,
- contain a real reaction, joke, clutch play, reveal, rant, or strong opinion.

Avoid: greetings, sub/donation read-outs, technical issues, waiting or loading, ads, and anything that only makes sense with prior context.

Rules:
- Use absolute seconds from the transcript; start and end must fall inside the transcript range you were given.
- Respect the requested clip length range.
- Do not return overlapping clips; if two ideas overlap, keep the stronger one.
- Score honestly: most moments in a stream are mediocre (below 50). Only truly great moments get 80+.
- Return fewer clips (or none) rather than padding with weak ones.`;

/** USD per million tokens (input, output) for the session cost estimate. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

export function buildTranscriptBlock(req: HighlightRequest): string {
  const stats = loudnessStats(req.loudness);
  return req.segments
    .map((s) => {
      const lift = Math.round(peakLoudness(req.loudness, s.startSeconds, s.endSeconds) - stats.median);
      const tag = lift >= 8 ? ` (LOUD +${lift} dB)` : '';
      return `[${Math.round(s.startSeconds)}s | ${formatTimestamp(s.startSeconds)}]${tag} ${s.text}`;
    })
    .join('\n');
}

/** Highlight selection with Claude, using structured outputs for a guaranteed JSON shape. */
export class ClaudeHighlightAnalyzer implements HighlightAnalyzer {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: { apiKey?: string; model: string; baseURL?: string }) {
    this.name = `anthropic:${opts.model}`;
    // Without an explicit key the SDK uses ANTHROPIC_API_KEY or an `ant auth login` profile.
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), maxRetries: 2 });
  }

  async analyze(req: HighlightRequest): Promise<HighlightResponse> {
    const prompt = buildHighlightPrompt(req);
    let response;
    try {
      // `create` (not `parse`) so refusals and truncation are checked before parsing the body.
      response = await this.client.beta.messages.create({
        model: this.opts.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        // On a safety decline, the API retries the request on a suitable fallback model.
        fallbacks: 'default',
        output_config: { effort: 'medium', format: betaZodOutputFormat(HighlightOutput) },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    if (response.stop_reason === 'refusal') {
      throw new AiProviderError('REFUSED', 'The model declined to analyse this transcript', false);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AiProviderError('BAD_RESPONSE', 'Highlight analysis output was cut off (max_tokens)', true);
    }
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    let parsed: z.infer<typeof HighlightOutput>;
    try {
      parsed = HighlightOutput.parse(JSON.parse(text));
    } catch (err) {
      throw new AiProviderError('BAD_RESPONSE', `Highlight analysis returned invalid JSON: ${(err as Error).message.slice(0, 200)}`, true);
    }

    const [inPrice, outPrice] = PRICES[this.opts.model] ?? PRICES['claude-opus-5-5']!;
    const costUsd = (response.usage.input_tokens * inPrice + response.usage.output_tokens * outPrice) / 1_000_000;

    return { highlights: mapHighlightOutput(parsed), costUsd };
  }
}

export function buildHighlightPrompt(req: HighlightRequest): string {
  return [
    `Stream: "${req.streamTitle || 'Untitled'}" by ${req.streamerName}.`,
    `This part covers ${formatTimestamp(req.windowStartSeconds)}–${formatTimestamp(req.windowEndSeconds)} (${Math.round(req.windowStartSeconds)}s–${Math.round(req.windowEndSeconds)}s).`,
    `Clip length: ${req.clip.minSeconds}-${req.clip.maxSeconds} seconds, ideally about ${req.clip.targetSeconds}.`,
    `Return at most ${req.maxCandidates} clips, best first.`,
    '',
    '<transcript>',
    buildTranscriptBlock(req),
    '</transcript>',
  ].join('\n');
}

export function mapHighlightOutput(parsed: z.infer<typeof HighlightOutput>): RawHighlight[] {
  return parsed.highlights.map((h) => ({
      startSeconds: h.start_seconds,
      endSeconds: h.end_seconds,
      keyMomentSeconds: h.key_moment_seconds,
      score: h.overall_score,
      breakdown: {
        hook: h.hook_score,
        emotion: h.emotion_score,
        entertainment: h.entertainment_score,
        context: h.context_score,
        payoff: h.payoff_score,
        clarity: h.clarity_score,
      },
      hook: h.hook,
      reason: h.reason,
      topic: h.topic || null,
  }));
}

export function mapAnthropicError(err: unknown): AiProviderError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError('AUTH', 'Anthropic API rejected the credentials. Check LLM_API_KEY / ANTHROPIC_API_KEY.', false);
  }
  if (err instanceof Anthropic.RateLimitError) return new AiProviderError('RATE_LIMITED', 'Anthropic API rate limit reached', true);
  if (err instanceof Anthropic.BadRequestError) return new AiProviderError('BAD_REQUEST', `Anthropic API rejected the request: ${err.message}`, false);
  if (err instanceof Anthropic.APIConnectionError) return new AiProviderError('UNAVAILABLE', `Could not reach the Anthropic API: ${err.message}`, true);
  if (err instanceof Anthropic.APIError) {
    return new AiProviderError('UNAVAILABLE', `Anthropic API error ${err.status ?? ''}: ${err.message}`, (err.status ?? 500) >= 500);
  }
  return new AiProviderError('BAD_RESPONSE', (err as Error).message, true);
}

/**
 * Offline analyzer for development and tests: slides a window over the stream
 * and scores it from loudness spikes and excited phrases. No API calls.
 */
export class HeuristicHighlightAnalyzer implements HighlightAnalyzer {
  readonly name = 'heuristic';

  async analyze(req: HighlightRequest): Promise<HighlightResponse> {
    const stats = loudnessStats(req.loudness);
    const len = req.clip.targetSeconds;
    const scored: RawHighlight[] = [];
    for (let start = req.windowStartSeconds; start + req.clip.minSeconds <= req.windowEndSeconds; start += 5) {
      const end = Math.min(req.windowEndSeconds, start + len);
      const audio = audioScore(req.loudness, start, end, stats);
      const hits = excitementHits(req.segments, start, end);
      const words = Math.min(100, hits * 20);
      const score = Math.round(0.65 * audio + 0.35 * words);
      // Key moment = loudest second; useful for later reframing and thumbnails.
      let key = start;
      for (let s = Math.floor(start); s < end; s++) if ((req.loudness[s] ?? -99) > (req.loudness[key] ?? -99)) key = s;
      const first = req.segments.find((s) => s.endSeconds > start && s.startSeconds < end);
      scored.push({
        startSeconds: start,
        endSeconds: end,
        keyMomentSeconds: key,
        score,
        breakdown: { hook: words, emotion: audio, entertainment: Math.round((audio + words) / 2), context: 50, payoff: audio, clarity: 50 },
        hook: (first?.text ?? '').slice(0, 60),
        reason: `Audio ${Math.round(peakLoudness(req.loudness, start, end) - stats.median)} dB above the stream's typical level; ${hits} excited phrase${hits === 1 ? '' : 's'}.`,
        topic: null,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked: RawHighlight[] = [];
    for (const c of scored) {
      if (picked.length >= req.maxCandidates) break;
      if (picked.every((p) => c.endSeconds <= p.startSeconds || c.startSeconds >= p.endSeconds)) picked.push(c);
    }
    return { highlights: picked, costUsd: 0 };
  }
}
