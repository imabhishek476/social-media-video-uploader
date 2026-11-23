// Local speech-to-text with NVIDIA Parakeet (sherpa-onnx). Runs in its own
// process so the heavy CPU work never blocks the job worker.
//
//   node parakeet-worker.mjs <audio file> <model dir> [threads]
//
// Prints one JSON object: { language, segments: [{ start, end, text, words: [{ word, start, end }] }] }
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const [, , audioPath, modelDir, threadsArg] = process.argv;
if (!audioPath || !modelDir) {
  console.error('usage: parakeet-worker.mjs <audio> <modelDir> [threads]');
  process.exit(2);
}
const RATE = 16000;
const MAX_WINDOW = 20; // seconds per decode (the model is trained on short utterances)
const MIN_WINDOW = 8;

/** Decode any audio file to 16 kHz mono float samples with ffmpeg. */
function decodeAudio(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-']);
    const parts = [];
    let err = '';
    p.stdout.on('data', (d) => parts.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed: ${err.slice(-300)}`));
      const buf = Buffer.concat(parts);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

/** Cut into windows of at most MAX_WINDOW s, ending at the quietest 100 ms in the last part of each window. */
function windows(samples) {
  const hop = RATE / 10;
  const energy = [];
  for (let i = 0; i < samples.length; i += hop) {
    let s = 0;
    const end = Math.min(samples.length, i + hop);
    for (let j = i; j < end; j++) s += samples[j] * samples[j];
    energy.push(s / Math.max(1, end - i));
  }
  const out = [];
  let start = 0; // in hops
  const total = energy.length;
  while (start < total) {
    if (total - start <= MAX_WINDOW * 10) {
      out.push([start, total]);
      break;
    }
    let best = start + MAX_WINDOW * 10;
    let bestE = Infinity;
    for (let h = start + MIN_WINDOW * 10; h < start + MAX_WINDOW * 10; h++) {
      if (energy[h] < bestE) {
        bestE = energy[h];
        best = h;
      }
    }
    out.push([start, best]);
    start = best;
  }
  return out.map(([a, b]) => [a * hop, Math.min(samples.length, b * hop)]);
}

const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: RATE, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(modelDir, 'encoder.int8.onnx'),
      decoder: path.join(modelDir, 'decoder.int8.onnx'),
      joiner: path.join(modelDir, 'joiner.int8.onnx'),
    },
    tokens: path.join(modelDir, 'tokens.txt'),
    numThreads: Number(threadsArg) || 4,
    provider: 'cpu',
    modelType: 'nemo_transducer',
    debug: 0,
  },
});

const samples = await decodeAudio(audioPath);
const words = [];
for (const [a, b] of windows(samples)) {
  if (b - a < RATE * 0.3) continue;
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: RATE, samples: samples.subarray(a, b) });
  recognizer.decode(stream);
  const r = recognizer.getResult(stream);
  const offset = a / RATE;
  const tokens = r.tokens ?? [];
  const times = r.timestamps ?? [];
  const winEnd = b / RATE;
  // Tokens are word pieces; a leading space or "▁" starts a new word.
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const t = offset + (times[i] ?? 0);
    const startsWord = /^[\s▁]/.test(raw) || words.length === 0 || i === 0;
    const piece = raw.replace(/▁/g, ' ');
    if (startsWord) words.push({ word: piece.trim(), start: t, end: t });
    else words[words.length - 1].word += piece;
    const next = i + 1 < tokens.length ? offset + (times[i + 1] ?? 0) : Math.min(winEnd, t + 0.6);
    words[words.length - 1].end = Math.max(t + 0.08, Math.min(next, t + 0.7));
  }
}

// Group words into sentence-like segments.
const segments = [];
let cur = [];
const flush = () => {
  if (!cur.length) return;
  segments.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word).join(' ').replace(/\s+([,.!?])/g, '$1'), words: cur });
  cur = [];
};
for (const w of words.filter((x) => x.word)) {
  const prev = cur[cur.length - 1];
  if (prev && (w.start - prev.end > 0.9 || cur.length >= 16)) flush();
  cur.push({ word: w.word, start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 });
  if (/[.!?]$/.test(w.word)) flush();
}
flush();
process.stdout.write(JSON.stringify({ language: 'en', segments }));
