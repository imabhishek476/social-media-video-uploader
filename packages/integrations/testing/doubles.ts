/**
 * Test doubles for the provider interfaces. Never used by the running app:
 * the API and worker require real providers (see packages/config).
 * Import from '@shorts/integrations/testing' in tests only.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import {
  audioScore,
  excitementHits,
  finalizeMetadata,
  loudnessStats,
  peakLoudness,
  type HighlightAnalyzer,
  type HighlightRequest,
  type HighlightResponse,
  type MetadataGenerator,
  type MetadataRequest,
  type RawHighlight,
  type TranscriptionOutput,
  type TranscriptionProvider,
  type UploadInput,
  type VideoMetadata,
  type YouTubeUploader,
} from '../src';

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

/** Development stand-in: "uploads" instantly and returns a fake video id. */
export class MockYouTubeUploader implements YouTubeUploader {
  readonly name = 'mock' as const;
  readonly uploads: Array<{ videoId: string; metadata: VideoMetadata; bytes: number }> = [];

  async upload(input: UploadInput): Promise<{ videoId: string }> {
    const bytes = (await fsp.stat(input.filePath)).size;
    await input.onSession(`mock://upload/${crypto.randomUUID()}`);
    await input.onProgress?.(1);
    const videoId = `mock${crypto.randomBytes(4).toString('hex')}`;
    this.uploads.push({ videoId, metadata: input.metadata, bytes });
    return { videoId };
  }

  async setThumbnail(): Promise<void> {}
}
