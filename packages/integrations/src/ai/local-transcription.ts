import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiProviderError, type TranscriptionOutput, type TranscriptionProvider } from './types';

const WORKER = fileURLToPath(new URL('../../asr/parakeet-worker.mjs', import.meta.url));

/**
 * Speech-to-text on this machine with NVIDIA Parakeet (sherpa-onnx): free,
 * no rate limits, audio never leaves the machine. English only, so other
 * languages go to `fallback` (e.g. Groq Whisper) when one is configured.
 * Runs in a child process so the worker's event loop (and job locks) stay alive.
 */
export class LocalParakeetTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'local:parakeet-tdt-0.6b-v2';
  /** Chunks are only split by length for local work; size is irrelevant. */
  readonly maxFileBytes = 1024 * 1024 * 1024;
  readonly costPerMinuteUsd = 0;

  constructor(private readonly opts: { modelDir: string; threads: number; fallback?: TranscriptionProvider; timeoutMs?: number }) {}

  modelReady(): boolean {
    return ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].every((f) => {
      try {
        return fs.statSync(path.join(this.opts.modelDir, f)).size > 0;
      } catch {
        return false;
      }
    });
  }

  async transcribe(audioPath: string, opts: { language?: string; durationSeconds: number }): Promise<TranscriptionOutput> {
    const lang = (opts.language ?? 'en').toLowerCase();
    if (!lang.startsWith('en')) {
      if (this.opts.fallback) return this.opts.fallback.transcribe(audioPath, opts);
      throw new AiProviderError('BAD_REQUEST', `Local transcription is English-only; set TRANSCRIPTION_API_KEY to transcribe "${lang}"`, false);
    }
    if (!this.modelReady()) {
      if (this.opts.fallback) return this.opts.fallback.transcribe(audioPath, opts);
      throw new AiProviderError('BAD_REQUEST', `Speech model not found in ${this.opts.modelDir}`, false);
    }
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, [WORKER, audioPath, this.opts.modelDir, String(this.opts.threads)], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let err = '';
      const timer = setTimeout(() => p.kill('SIGKILL'), this.opts.timeoutMs ?? Math.max(10 * 60_000, opts.durationSeconds * 1000 * 2));
      p.stdout.on('data', (d: Buffer) => chunks.push(d));
      p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
      p.on('error', (e) => (clearTimeout(timer), reject(e)));
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
        else reject(new AiProviderError('UNAVAILABLE', `Local transcription failed (${code}): ${err.trim().split('\n').slice(-2).join(' | ')}`, true));
      });
    });
    let data: { language?: string; segments?: Array<{ start: number; end: number; text: string; words?: Array<{ word: string; start: number; end: number }> }> };
    try {
      data = JSON.parse(out);
    } catch {
      throw new AiProviderError('BAD_RESPONSE', 'Local transcription returned invalid output', true);
    }
    return {
      language: data.language ?? 'en',
      segments: (data.segments ?? []).map((s) => ({
        startSeconds: s.start,
        endSeconds: Math.min(s.end, opts.durationSeconds || s.end),
        text: s.text,
        confidence: null,
        words: (s.words ?? []).map((w) => ({ word: w.word, startSeconds: w.start, endSeconds: w.end })),
      })),
    };
  }
}
