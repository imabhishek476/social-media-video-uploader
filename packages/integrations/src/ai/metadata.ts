import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { mapAnthropicError } from './highlights';
import { AiProviderError } from './types';

/** What the model knows about one Short when writing its metadata. */
export interface MetadataRequest {
  streamerName: string;
  streamTitle: string;
  sourceUrl: string;
  hook: string;
  reason: string;
  topic: string | null;
  transcriptExcerpt: string;
  durationSeconds: number;
  language: string;
}

export interface ShortMetadata {
  title: string;
  description: string;
  tags: string[];
}

export interface MetadataGenerator {
  readonly name: string;
  generate(req: MetadataRequest): Promise<ShortMetadata & { costUsd: number }>;
}

const MetadataOutput = z.object({
  title: z.string().describe('Punchy Short title, max 70 characters, no hashtags, no clickbait lies'),
  description: z.string().describe('1-2 sentence description of the moment, max 300 characters, no links, no hashtags'),
  hashtags: z.array(z.string()).describe('3-5 relevant hashtags without the # sign, e.g. GTA6, gaming'),
  tags: z.array(z.string()).describe('5-12 search tags (plain words/phrases)'),
});

const SYSTEM = `You write YouTube Shorts metadata for clips cut from livestreams.
Write in the language of the transcript. The title must make people want to watch, describe what actually happens, and stay under 70 characters. Do not use quotation marks around the title, ALL CAPS sentences, emojis in excess (at most one), or angle brackets.
The description briefly sets up the moment. Never invent facts that are not supported by the hook, reason or transcript.`;

function prompt(r: MetadataRequest): string {
  return [
    `Streamer: ${r.streamerName}`,
    `Stream title: ${r.streamTitle || 'Untitled'}`,
    `Clip length: ${Math.round(r.durationSeconds)}s`,
    `Topic: ${r.topic ?? '-'}`,
    `Why it was picked: ${r.reason || '-'}`,
    `Suggested hook: ${r.hook || '-'}`,
    `Transcript language: ${r.language}`,
    '<transcript>',
    r.transcriptExcerpt || '(no speech)',
    '</transcript>',
  ].join('\n');
}

/** YouTube rejects `<` and `>` in titles and descriptions. */
const clean = (s: string) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
const tagify = (s: string) => s.replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '');

/**
 * Normalise model output into upload-safe metadata: limits from the YouTube
 * Data API (title ≤ 100, description ≤ 5000, tags ≤ 500 chars total), a credit
 * line pointing at the original stream, and #Shorts.
 */
export function finalizeMetadata(raw: { title: string; description: string; hashtags: string[]; tags: string[] }, req: MetadataRequest): ShortMetadata {
  const hashtags = [...new Set(['Shorts', ...raw.hashtags.map(tagify).filter(Boolean)])].slice(0, 5);
  let title = clean(raw.title).replace(/^["']|["']$/g, '') || clean(req.hook) || `${req.streamerName} stream highlight`;
  if (title.length > 90) title = `${title.slice(0, 89).trimEnd()}…`;
  const description = [
    clean(raw.description).slice(0, 1000),
    '',
    `🎮 From ${clean(req.streamerName)}'s stream: ${req.sourceUrl}`,
    '',
    hashtags.map((h) => `#${h}`).join(' '),
  ].join('\n');
  const tags: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const t of [...raw.tags, req.streamerName, ...raw.hashtags].map((x) => clean(x).replace(/^#/, '')).filter(Boolean)) {
    // Case-insensitive de-duplication ("mock gamer" vs "Mock Gamer").
    const k = t.toLowerCase().replace(/\s+/g, '');
    if (t.length > 30 || seen.has(k)) continue;
    seen.add(k);
    // Tags with spaces count their quotes against the 500-character budget.
    const cost = t.length + (t.includes(' ') ? 2 : 0) + 1;
    if (total + cost > 480) break;
    tags.push(t);
    total += cost;
  }
  return { title, description, tags };
}

export class ClaudeMetadataGenerator implements MetadataGenerator {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: { apiKey?: string; model: string; baseURL?: string }) {
    this.name = `anthropic:${opts.model}`;
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), maxRetries: 2 });
  }

  async generate(req: MetadataRequest) {
    let res;
    try {
      res = await this.client.beta.messages.create({
        model: this.opts.model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: betaZodOutputFormat(MetadataOutput) },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt(req) }],
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }
    if (res.stop_reason === 'refusal') throw new AiProviderError('REFUSED', 'The model declined to write metadata for this clip', false);
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const parsed = parseOrThrow(text);
    const costUsd = (res.usage.input_tokens * 4 + res.usage.output_tokens * 20) / 1_000_000;
    return { ...finalizeMetadata(parsed, req), costUsd };
  }
}

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'Punchy Short title, max 70 characters, no hashtags' },
    description: { type: 'STRING', description: '1-2 sentence description, max 300 characters, no links, no hashtags' },
    hashtags: { type: 'ARRAY', items: { type: 'STRING' }, description: '3-5 hashtags without #' },
    tags: { type: 'ARRAY', items: { type: 'STRING' }, description: '5-12 search tags' },
  },
  required: ['title', 'description', 'hashtags', 'tags'],
};

export class GeminiMetadataGenerator implements MetadataGenerator {
  readonly name: string;
  constructor(private readonly opts: { apiKey: string; model: string; baseUrl?: string }) {
    this.name = `gemini:${opts.model}`;
  }

  async generate(req: MetadataRequest) {
    const base = (this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/models/${encodeURIComponent(this.opts.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: prompt(req) }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, maxOutputTokens: 4000 },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new AiProviderError('UNAVAILABLE', `Could not reach the Gemini API: ${(err as Error).message}`, true);
    }
    const data = (await res.json().catch(() => ({}))) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      error?: { message?: string };
    };
    if (!res.ok) {
      const msg = (data.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new AiProviderError('AUTH', `Gemini API rejected the key: ${msg}`, false);
      if (res.status === 429) throw new AiProviderError('RATE_LIMITED', `Gemini quota reached: ${msg}`, true);
      throw new AiProviderError(res.status >= 500 ? 'UNAVAILABLE' : 'BAD_REQUEST', `Gemini API error ${res.status}: ${msg}`, res.status >= 500);
    }
    const cand = data.candidates?.[0];
    if (cand?.finishReason && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(cand.finishReason)) {
      throw new AiProviderError('REFUSED', `Gemini declined to write metadata (${cand.finishReason})`, false);
    }
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    return { ...finalizeMetadata(parseOrThrow(text), req), costUsd: 0 };
  }
}

/** Offline template-based metadata for development and tests. */
export class TemplateMetadataGenerator implements MetadataGenerator {
  readonly name = 'template';
  async generate(req: MetadataRequest) {
    const title = req.hook || (req.topic ? `${req.streamerName}: ${req.topic}` : `${req.streamerName} stream highlight`);
    return {
      ...finalizeMetadata({ title, description: req.reason || `A moment from ${req.streamerName}'s stream.`, hashtags: ['gaming', 'livestream'], tags: [req.topic ?? 'highlight', 'stream highlights'] }, req),
      costUsd: 0,
    };
  }
}

function parseOrThrow(text: string) {
  try {
    return MetadataOutput.parse(JSON.parse(text));
  } catch (err) {
    throw new AiProviderError('BAD_RESPONSE', `Metadata output was not valid JSON: ${(err as Error).message.slice(0, 200)}`, true);
  }
}
