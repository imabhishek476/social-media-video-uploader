import fsp from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { mapAnthropicError } from './highlights';
import { AiProviderError } from './types';

/** Normalised rectangle (0–1 of frame width/height). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Finds the streamer's webcam overlay in a few frames of the stream. */
export interface FacecamDetector {
  readonly name: string;
  detect(jpegPaths: string[]): Promise<Box | null>;
}

const PROMPT = `These are frames from the same livestream recording, taken minutes apart.
Is there a webcam / facecam overlay showing the streamer's face (a smaller rectangle composited over gameplay or a screen), at the SAME position in the frames?
If yes, return found=true and its bounding box. If the whole frame is the camera (just-chatting / IRL), or there is no camera, return found=false.`;

/** Reject boxes that cannot be a facecam overlay (whole frame, a sliver). */
export function plausibleFacecam(b: Box | null): Box | null {
  if (!b) return null;
  const x = Math.max(0, Math.min(1, b.x));
  const y = Math.max(0, Math.min(1, b.y));
  const w = Math.max(0, Math.min(1 - x, b.w));
  const h = Math.max(0, Math.min(1 - y, b.h));
  const area = w * h;
  if (area < 0.01 || area > 0.45 || w < 0.05 || h < 0.05) return null;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}
const round = (n: number) => Math.round(n * 10000) / 10000;

/** Gemini vision; boxes come back as [ymin, xmin, ymax, xmax] on a 0–1000 grid. */
export class GeminiFacecamDetector implements FacecamDetector {
  readonly name: string;
  constructor(private readonly opts: { apiKey: string; model: string; baseUrl?: string }) {
    this.name = `gemini:${opts.model}`;
  }

  async detect(jpegPaths: string[]): Promise<Box | null> {
    const images = await Promise.all(jpegPaths.map(async (p) => ({ inlineData: { mimeType: 'image/jpeg', data: (await fsp.readFile(p)).toString('base64') } })));
    const base = (this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/models/${encodeURIComponent(this.opts.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [...images, { text: PROMPT }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                found: { type: 'BOOLEAN' },
                box_2d: { type: 'ARRAY', items: { type: 'INTEGER' }, description: '[ymin, xmin, ymax, xmax] normalised to 0-1000' },
              },
              required: ['found'],
            },
            maxOutputTokens: 2000,
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new AiProviderError('UNAVAILABLE', `Could not reach the Gemini API: ${(err as Error).message}`, true);
    }
    const data = (await res.json().catch(() => ({}))) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>; error?: { message?: string } };
    if (!res.ok) throw new AiProviderError(res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'UNAVAILABLE' : 'BAD_REQUEST', `Gemini facecam detection failed: ${data.error?.message ?? res.status}`, res.status === 429 || res.status >= 500);
    const text = (data.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    let out: { found?: boolean; box_2d?: number[] };
    try {
      out = JSON.parse(text);
    } catch {
      return null;
    }
    if (!out.found || out.box_2d?.length !== 4) return null;
    const [ymin, xmin, ymax, xmax] = out.box_2d.map((v) => v / 1000) as [number, number, number, number];
    return plausibleFacecam({ x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin });
  }
}

const ClaudeBox = z.object({
  found: z.boolean(),
  x: z.number().describe('left edge, fraction of frame width 0-1'),
  y: z.number().describe('top edge, fraction of frame height 0-1'),
  w: z.number().describe('width, fraction of frame width'),
  h: z.number().describe('height, fraction of frame height'),
});

export class ClaudeFacecamDetector implements FacecamDetector {
  readonly name: string;
  private readonly client: Anthropic;
  constructor(private readonly opts: { apiKey?: string; model: string }) {
    this.name = `anthropic:${opts.model}`;
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async detect(jpegPaths: string[]): Promise<Box | null> {
    const images = await Promise.all(
      jpegPaths.map(async (p) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: (await fsp.readFile(p)).toString('base64') } })),
    );
    let res;
    try {
      res = await this.client.beta.messages.create({
        model: this.opts.model,
        max_tokens: 2000,
        output_config: { effort: 'low', format: betaZodOutputFormat(ClaudeBox) },
        messages: [{ role: 'user', content: [...images, { type: 'text', text: `${PROMPT}\nGive the box as fractions of the frame (x, y = top-left corner).` }] }],
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }
    if (res.stop_reason === 'refusal') return null;
    try {
      const b = ClaudeBox.parse(JSON.parse(res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')));
      return b.found ? plausibleFacecam(b) : null;
    } catch {
      return null;
    }
  }
}
