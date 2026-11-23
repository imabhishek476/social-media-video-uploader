import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiProviderError, ClaudeHighlightAnalyzer, GeminiFacecamDetector, GeminiHighlightAnalyzer, plausibleFacecam, OpenAiCompatibleTranscriptionProvider, type HighlightRequest } from '../src';
import { HeuristicHighlightAnalyzer } from '../testing';

interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
let server: http.Server;
let base: string;
const captured: Captured[] = [];
let reply: (c: Captured) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const c = { url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      captured.push(c);
      const r = reply(c);
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const request: HighlightRequest = {
  streamTitle: 'Late night ranked',
  streamerName: 'Tester',
  windowStartSeconds: 0,
  windowEndSeconds: 120,
  segments: [
    { startSeconds: 10, endSeconds: 14, text: 'okay here we go' },
    { startSeconds: 60, endSeconds: 63, text: 'NO WAY that just happened!' },
  ],
  loudness: Array.from({ length: 120 }, (_, i) => (i >= 60 && i < 66 ? -6 : -35)),
  clip: { minSeconds: 30, maxSeconds: 60, targetSeconds: 45 },
  maxCandidates: 3,
};

describe('OpenAiCompatibleTranscriptionProvider', () => {
  it('sends a multipart Whisper request and maps segments', async () => {
    const audio = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'stt-')), 'chunk_0000.mp3');
    await fs.writeFile(audio, Buffer.from('fake-mp3'));
    reply = () => ({
      status: 200,
      body: {
        language: 'english',
        segments: [
          { start: 0, end: 2.5, text: ' hello chat ', avg_logprob: -0.1, no_speech_prob: 0.01 },
          { start: 3, end: 4, text: ' ', avg_logprob: -0.1 },
          { start: 5, end: 6, text: 'music', avg_logprob: -1, no_speech_prob: 0.95 },
        ],
      },
    });
    const p = new OpenAiCompatibleTranscriptionProvider({ apiKey: 'sk-test', baseUrl: `${base}/v1/`, model: 'whisper-1', costPerMinuteUsd: 0.006 });
    const out = await p.transcribe(audio, { durationSeconds: 6 });
    const req = captured.at(-1)!;
    expect(req.url).toBe('/v1/audio/transcriptions');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.headers['content-type']).toMatch(/multipart\/form-data/);
    const body = req.body.toString();
    expect(body).toContain('verbose_json');
    expect(body).toContain('timestamp_granularities[]');
    expect(body).toContain('fake-mp3');
    expect(out.segments).toEqual([{ startSeconds: 0, endSeconds: 2.5, text: 'hello chat', confidence: 0.905 }]);
  });

  it('classifies HTTP errors', async () => {
    const audio = path.join(os.tmpdir(), `stt-${Date.now()}.mp3`);
    await fs.writeFile(audio, 'x');
    const p = new OpenAiCompatibleTranscriptionProvider({ apiKey: 'k', baseUrl: base, model: 'm', costPerMinuteUsd: 0 });
    for (const [status, code, retryable] of [[401, 'AUTH', false], [429, 'RATE_LIMITED', true], [503, 'UNAVAILABLE', true], [400, 'BAD_REQUEST', false]] as const) {
      reply = () => ({ status, body: { error: { message: 'nope' } } });
      const err = await p.transcribe(audio, { durationSeconds: 1 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err).toMatchObject({ code, retryable });
    }
  });
});

describe('ClaudeHighlightAnalyzer', () => {
  const message = (text: string, stop_reason = 'end_turn') => ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200 },
  });

  it('sends a structured-output request and maps the result', async () => {
    const output = {
      highlights: [
        {
          start_seconds: 50,
          end_seconds: 95,
          key_moment_seconds: 61,
          hook: 'He did NOT expect that',
          reason: 'Huge reaction with a clear payoff.',
          topic: 'clutch win',
          hook_score: 80,
          emotion_score: 90,
          entertainment_score: 85,
          context_score: 70,
          payoff_score: 88,
          clarity_score: 75,
          overall_score: 86,
        },
      ],
    };
    reply = () => ({ status: 200, body: message(JSON.stringify(output)) });
    const a = new ClaudeHighlightAnalyzer({ apiKey: 'sk-ant-test', model: 'claude-opus-5-5', baseURL: base });
    const res = await a.analyze(request);

    const req = captured.at(-1)!;
    expect(req.url).toMatch(/^\/v1\/messages/);
    expect(req.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    const body = JSON.parse(req.body.toString());
    expect(body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'medium', format: { type: 'json_schema' } } });
    expect(body.messages[0].content).toContain('[60s | 1:00] (LOUD +29 dB) NO WAY that just happened!');

    expect(res.highlights).toEqual([
      expect.objectContaining({ startSeconds: 50, endSeconds: 95, keyMomentSeconds: 61, score: 86, hook: 'He did NOT expect that', topic: 'clutch win' }),
    ]);
    expect(res.costUsd).toBeCloseTo((1000 * 4 + 200 * 20) / 1e6, 8);
  });

  it('maps refusals and auth failures to permanent errors', async () => {
    const a = new ClaudeHighlightAnalyzer({ apiKey: 'k', model: 'claude-opus-5-5', baseURL: base });
    reply = () => ({ status: 200, body: message('', 'refusal') });
    await expect(a.analyze(request)).rejects.toMatchObject({ code: 'REFUSED', retryable: false });
    reply = () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    await expect(a.analyze(request)).rejects.toMatchObject({ code: 'AUTH', retryable: false });
  });
});

describe('HeuristicHighlightAnalyzer', () => {
  it('ranks the loud, excited moment first without overlaps', async () => {
    const res = await new HeuristicHighlightAnalyzer().analyze(request);
    expect(res.highlights[0]!.startSeconds).toBeLessThanOrEqual(60);
    expect(res.highlights[0]!.endSeconds).toBeGreaterThan(60);
    const sorted = [...res.highlights].sort((x, y) => x.startSeconds - y.startSeconds);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.startSeconds).toBeGreaterThanOrEqual(sorted[i - 1]!.endSeconds);
  });
});

describe('GeminiHighlightAnalyzer', () => {
  const out = {
    highlights: [
      { start_seconds: 55, end_seconds: 100, key_moment_seconds: 61, hook: 'Wait for it', reason: 'Big reaction.', topic: 'clutch', hook_score: 70, emotion_score: 90, entertainment_score: 80, context_score: 60, payoff_score: 85, clarity_score: 70, overall_score: 82 },
    ],
  };

  it('sends a schema-constrained request and ignores thought parts', async () => {
    reply = () => ({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: JSON.stringify(out) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    });
    const a = new GeminiHighlightAnalyzer({ apiKey: 'AQ.test', model: 'gemini-3.8-flash', baseUrl: `${base}/v1beta` });
    const res = await a.analyze(request);
    const req = captured.at(-1)!;
    expect(req.url).toBe('/v1beta/models/gemini-3.8-flash:generateContent');
    expect(req.headers['x-goog-api-key']).toBe('AQ.test');
    const body = JSON.parse(req.body.toString());
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } });
    expect(body.contents[0].parts[0].text).toContain('(LOUD +29 dB) NO WAY');
    expect(res).toEqual({ highlights: [expect.objectContaining({ startSeconds: 55, endSeconds: 100, score: 82, hook: 'Wait for it' })], costUsd: 0 });
  });

  it('classifies safety blocks, quota and auth errors', async () => {
    const a = new GeminiHighlightAnalyzer({ apiKey: 'k', model: 'm', baseUrl: base });
    reply = () => ({ status: 200, body: { candidates: [{ finishReason: 'SAFETY' }] } });
    await expect(a.analyze(request)).rejects.toMatchObject({ code: 'REFUSED', retryable: false });
    reply = () => ({ status: 429, body: { error: { message: 'quota' } } });
    await expect(a.analyze(request)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    reply = () => ({ status: 403, body: { error: { message: 'denied' } } });
    await expect(a.analyze(request)).rejects.toMatchObject({ code: 'AUTH', retryable: false });
  });
});

describe('word timestamps and facecam detection', () => {
  it('requests word timing and attaches each word to its segment', async () => {
    const audio = path.join(os.tmpdir(), `stt-words-${Date.now()}.mp3`);
    await fs.writeFile(audio, 'x');
    reply = () => ({
      status: 200,
      body: {
        language: 'en',
        segments: [
          { start: 0, end: 2, text: 'no way', avg_logprob: -0.1 },
          { start: 2, end: 4, text: 'lets go', avg_logprob: -0.1 },
        ],
        words: [
          { word: 'no', start: 0.1, end: 0.4 },
          { word: 'way', start: 0.5, end: 1.2 },
          { word: 'lets', start: 2.1, end: 2.5 },
          { word: 'go', start: 2.6, end: 3.0 },
        ],
      },
    });
    const p = new OpenAiCompatibleTranscriptionProvider({ apiKey: 'k', baseUrl: base, model: 'whisper-large-v3-turbo', costPerMinuteUsd: 0 });
    const out = await p.transcribe(audio, { durationSeconds: 4 });
    expect((captured.at(-1)!.body.toString().match(/timestamp_granularities\[\]/g) ?? []).length).toBe(2);
    expect(out.segments[0]!.words).toEqual([
      { word: 'no', startSeconds: 0.1, endSeconds: 0.4 },
      { word: 'way', startSeconds: 0.5, endSeconds: 1.2 },
    ]);
    expect(out.segments[1]!.words!.map((w) => w.word)).toEqual(['lets', 'go']);
  });

  it('converts Gemini 0-1000 boxes and rejects implausible ones', async () => {
    const jpg = path.join(os.tmpdir(), `frame-${Date.now()}.jpg`);
    await fs.writeFile(jpg, 'jpeg');
    const d = new GeminiFacecamDetector({ apiKey: 'k', model: 'm', baseUrl: base });
    const answer = (o: unknown) => () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] } });
    reply = answer({ found: true, box_2d: [700, 750, 1000, 1000] }); // bottom-right webcam
    expect(await d.detect([jpg, jpg])).toEqual({ x: 0.75, y: 0.7, w: 0.25, h: 0.3 });
    expect(JSON.parse(captured.at(-1)!.body.toString()).contents[0].parts.filter((p: { inlineData?: unknown }) => p.inlineData)).toHaveLength(2);
    reply = answer({ found: true, box_2d: [0, 0, 1000, 1000] }); // whole frame = not an overlay
    expect(await d.detect([jpg])).toBeNull();
    reply = answer({ found: false });
    expect(await d.detect([jpg])).toBeNull();
    expect(plausibleFacecam({ x: 0.7, y: 0.7, w: 0.5, h: 0.5 })).toEqual({ x: 0.7, y: 0.7, w: 0.3, h: 0.3 }); // clamped to the frame
  });
});

describe('retryAfterMs', () => {
  it('reads Retry-After or a Groq-style message', async () => {
    const { retryAfterMs } = await import('../src');
    expect(retryAfterMs('30', '')).toBe(30_000);
    expect(retryAfterMs(null, 'Please try again in 7m26.5s. Need more tokens?')).toBe(446_500);
    expect(retryAfterMs(null, 'try again in 1h2m')).toBe(3_720_000);
    expect(retryAfterMs(null, 'nope')).toBeNull();
  });
});

describe('games, clip requests and local transcription routing', () => {
  it('detects the game from a setting or title and adds its hashtags', async () => {
    const { detectGame, finalizeMetadata } = await import('../src');
    expect(detectGame(null, 'BEATING GTA 6 RIGHT NOW 100%')?.name).toBe('Grand Theft Auto VI');
    expect(detectGame('BGMI', 'GTA 5 later')?.name).toBe('BGMI');
    expect(detectGame('GTA 5 RP with friends')?.name).toBe('GTA RP');
    expect(detectGame('just chatting')).toBeNull();
    const m = finalizeMetadata(
      { title: 'x', description: 'd', hashtags: ['gta6', 'funny'], tags: [] },
      { streamerName: 'S', streamTitle: '', sourceUrl: 'u', hook: '', reason: '', topic: null, transcriptExcerpt: '', durationSeconds: 30, language: 'en', game: detectGame('GTA 6') },
    );
    expect(m.description.split('\n').pop()).toBe('#Shorts #GTA6 #GTAVI #ViceCity #funny');
  });

  it('tags clip requests in the transcript', async () => {
    const { buildTranscriptBlock } = await import('../src');
    const block = buildTranscriptBlock({ segments: [{ startSeconds: 5, endSeconds: 7, text: 'chat clip that right now' }], loudness: [] } as never);
    expect(block).toContain('(CLIP REQUEST)');
  });

  it('sends non-English audio to the fallback and needs the model for English', async () => {
    const { LocalParakeetTranscriptionProvider } = await import('../src');
    const calls: string[] = [];
    const fallback = { name: 'groq', maxFileBytes: 1, costPerMinuteUsd: 0, transcribe: async (_p: string, o: { language?: string }) => (calls.push(o.language ?? ''), { language: 'hi', segments: [] }) };
    const p = new LocalParakeetTranscriptionProvider({ modelDir: '/nonexistent', threads: 1, fallback });
    expect(await p.transcribe('/x.mp3', { language: 'hi', durationSeconds: 10 })).toMatchObject({ language: 'hi' });
    await p.transcribe('/x.mp3', { language: 'en', durationSeconds: 10 }); // model missing → fallback
    expect(calls).toEqual(['hi', 'en']);
    const noFallback = new LocalParakeetTranscriptionProvider({ modelDir: '/nonexistent', threads: 1 });
    await expect(noFallback.transcribe('/x.mp3', { language: 'en', durationSeconds: 10 })).rejects.toThrow(/Speech model not found/);
  });
});
