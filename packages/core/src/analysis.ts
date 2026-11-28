import fsp from 'node:fs/promises';
import path from 'node:path';
import { HighlightCandidateModel, LiveSessionModel, StreamerChannelModel, TranscriptChunkModel, TranscriptModel, mongoose } from '@shorts/database';
import {
  AiProviderError,
  audioScore,
  chatScore,
  chatStats,
  detectGame,
  loudnessStats,
  type HighlightAnalyzer,
  type ObjectStorage,
  type RawHighlight,
  type TranscriptSegment,
  type TranscriptionProvider,
} from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { UnrecoverableError, idempotencyKey, type QueueRegistry } from '@shorts/queue';
import { CandidateStatus, JobType, ProcessingStage, ProcessingStatus, SessionStatus, SourceMediaStatus } from '@shorts/shared-types';
import { CategoryService } from './categories';
import { extractAudioChunks, measureLoudness, measureStaticRanges, staticShare } from './audio';
import { loadChatCounts } from './chat';
import { blendSignals, mergeHighlights, normalizeHighlight } from './highlights';
import { enqueueTracked } from './jobs';
import type { SettingsService } from './settings';

export interface AnalysisDeps {
  settings: SettingsService;
  storage: ObjectStorage;
  transcription: TranscriptionProvider;
  analyzer: HighlightAnalyzer;
  /** Scratch space for downloaded sources and audio (`<storageDir>/tmp`). */
  workDir: string;
  language?: string;
  logger?: Logger;
}

/** Transcript segments are grouped into documents of this many seconds. */
const CHUNK_WINDOW_SECONDS = 300;
/** Long streams are analysed in windows (with overlap so moments on a boundary aren't lost). */
const ANALYSIS_WINDOW_SECONDS = 30 * 60;
const ANALYSIS_WINDOW_OVERLAP = 90;
/** How much the audio signal moves an LLM score. */
const AUDIO_WEIGHT = 0.15;
/** How much a live-chat spike moves the score (only when chat was sampled). */
const CHAT_WEIGHT = 0.2;
/** Candidates kept for review beyond the auto-selected ones. */
const MAX_STORED_CANDIDATES = 25;

export type TranscribeOutcome = 'TRANSCRIBED' | 'CACHED' | 'SKIPPED';
export type AnalyzeOutcome = { selected: number; candidates: number; discarded: number } | 'SKIPPED';

/** Turn provider failures into queue semantics: permanent ones must not be retried. */
function asQueueError(err: unknown): Error {
  if (err instanceof AiProviderError && !err.retryable) return new UnrecoverableError(`${err.code}: ${err.message}`);
  return err as Error;
}

/**
 * Phase 4 pipeline (spec §6 Workflow E/F): transcription, then highlight
 * analysis. Each step is idempotent; reprocessing reuses an existing
 * transcript (the expensive part) and re-runs only the analysis.
 */
export class AnalysisService {
  constructor(private readonly deps: AnalysisDeps) {}

  /**
   * Long streams are transcribed in chunks. Finished chunks are saved next to
   * the work dir, so a rate limit (free tiers allow only a few hours of audio
   * per hour) pauses the job via `defer` and the next run continues where it stopped.
   */
  async transcribe(
    sessionId: string,
    onProgress?: (pct: number) => Promise<void>,
    defer?: (until: Date, reason: string) => Promise<never>,
  ): Promise<TranscribeOutcome> {
    const { storage, transcription, logger } = this.deps;
    const session = await LiveSessionModel.findById(sessionId).lean();
    if (!session || session.status === SessionStatus.CANCELLED) return 'SKIPPED';
    const existing = await TranscriptModel.findOne({ liveSessionId: sessionId }).select('_id chunkCount').lean();
    if (existing && existing.chunkCount > 0) return 'CACHED';
    if (session.sourceMedia?.status !== SourceMediaStatus.READY || !session.sourceMedia.storageKey) {
      throw new UnrecoverableError('Source media is not available; acquire it first');
    }

    await this.setStage(sessionId, ProcessingStage.TRANSCRIBING);
    const work = path.join(this.deps.workDir, `analysis-${sessionId}`);
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
    try {
      const key = session.sourceMedia.storageKey;
      const local = path.join(work, `source${path.extname(key)}`);
      await storage.download(key, local);
      await onProgress?.(10);

      const [chunks, loudness, staticRanges] = await Promise.all([
        extractAudioChunks(local, path.join(work, 'audio'), transcription.maxFileBytes),
        measureLoudness(local),
        measureStaticRanges(local),
      ]);
      await fsp.rm(local, { force: true }); // the video is no longer needed for this step
      await onProgress?.(25);

      // Chunks finished by an earlier (rate-limited) attempt.
      const partialPath = path.join(this.deps.workDir, `transcript-partial-${sessionId}.json`);
      // The streamer's language (Settings on the streamer page) picks the speech model.
      const streamerLang = (await StreamerChannelModel.findById(session.streamerChannelId).select('preferences.language').lean())?.preferences?.language;
      const speechLang = streamerLang || this.deps.language;
      type Partial = { chunks: number; done: Record<string, { language: string; segments: TranscriptSegment[] }> };
      let partial: Partial = { chunks: chunks.length, done: {} };
      try {
        const saved = JSON.parse(await fsp.readFile(partialPath, 'utf8')) as Partial;
        if (saved.chunks === chunks.length) partial = saved;
      } catch {
        // none yet
      }

      for (const [i, chunk] of chunks.entries()) {
        if (partial.done[i]) continue;
        let out;
        try {
          out = await transcription.transcribe(chunk.path, { language: speechLang ?? undefined, durationSeconds: chunk.durationSeconds });
        } catch (err) {
          if (defer && err instanceof AiProviderError && err.code === 'RATE_LIMITED') {
            await fsp.writeFile(partialPath, JSON.stringify(partial));
            const waitMs = Math.max(60_000, Math.min(err.retryAfterMs ?? 15 * 60_000, 2 * 60 * 60_000)) + 30_000;
            const until = new Date(Date.now() + waitMs);
            const msg = `Transcription paused by the provider's rate limit after ${Object.keys(partial.done).length}/${chunks.length} parts; continuing at ${until.toISOString().slice(11, 16)} UTC.`;
            await LiveSessionModel.updateOne({ _id: sessionId }, { $set: { lastError: msg } });
            logger?.info({ liveSessionId: sessionId, done: Object.keys(partial.done).length, total: chunks.length, until }, 'Transcription rate-limited; deferring');
            return await defer(until, msg);
          }
          throw err;
        }
        const o = chunk.offsetSeconds;
        partial.done[i] = {
          language: out.language,
          segments: out.segments.map((s) => ({
            ...s,
            startSeconds: s.startSeconds + o,
            endSeconds: Math.min(s.endSeconds, chunk.durationSeconds) + o,
            ...(s.words ? { words: s.words.map((w) => ({ word: w.word, startSeconds: w.startSeconds + o, endSeconds: w.endSeconds + o })) } : {}),
          })),
        };
        await fsp.writeFile(partialPath, JSON.stringify(partial));
        await onProgress?.(25 + Math.round((Object.keys(partial.done).length / chunks.length) * 70));
      }

      const segments: TranscriptSegment[] = [];
      let language = speechLang ?? 'en';
      for (let i = 0; i < chunks.length; i++) {
        const c = partial.done[i]!;
        language = c.language || language;
        segments.push(...c.segments);
      }
      const audioSeconds = chunks.reduce((n, c) => n + c.durationSeconds, 0);
      const costUsd = (audioSeconds / 60) * transcription.costPerMinuteUsd;
      await this.saveTranscript(sessionId, { provider: transcription.name, language, durationSeconds: Math.round(audioSeconds), segments, loudness, staticRanges, costUsd });
      await LiveSessionModel.updateOne({ _id: sessionId }, { $inc: { estimatedCostUsd: costUsd } });
      await fsp.rm(partialPath, { force: true });
      await LiveSessionModel.updateOne({ _id: sessionId }, { $set: { lastError: null } });
      logger?.info({ liveSessionId: sessionId, segments: segments.length, audioSeconds: Math.round(audioSeconds), costUsd }, 'Transcript ready');
      return 'TRANSCRIBED';
    } catch (err) {
      throw asQueueError(err);
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async saveTranscript(
    sessionId: string,
    t: { provider: string; language: string; durationSeconds: number; segments: TranscriptSegment[]; loudness: number[]; staticRanges?: Array<[number, number]>; costUsd: number },
  ) {
    // Replace atomically enough for our purposes: chunks first, header (the "done" marker) last.
    const old = await TranscriptModel.findOne({ liveSessionId: sessionId }).select('_id').lean();
    if (old) await Promise.all([TranscriptChunkModel.deleteMany({ transcriptId: old._id }), TranscriptModel.deleteOne({ _id: old._id })]);
    const transcriptId = new mongoose.Types.ObjectId();
    const groups = new Map<number, TranscriptSegment[]>();
    for (const s of t.segments) {
      const idx = Math.floor(s.startSeconds / CHUNK_WINDOW_SECONDS);
      groups.set(idx, [...(groups.get(idx) ?? []), s]);
    }
    const docs = [...groups.entries()].map(([index, segs]) => ({
      transcriptId,
      liveSessionId: sessionId,
      index,
      startSeconds: index * CHUNK_WINDOW_SECONDS,
      endSeconds: (index + 1) * CHUNK_WINDOW_SECONDS,
      segments: segs,
    }));
    if (docs.length) await TranscriptChunkModel.insertMany(docs);
    await TranscriptModel.create({
      _id: transcriptId,
      liveSessionId: sessionId,
      provider: t.provider,
      language: t.language,
      durationSeconds: t.durationSeconds,
      segmentCount: t.segments.length,
      // A transcript with no speech still counts as done (loudness can still find moments).
      chunkCount: Math.max(1, docs.length),
      loudness: t.loudness,
      staticRanges: t.staticRanges ?? [],
      costUsd: t.costUsd,
    });
  }

  loadSegments(sessionId: string, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<TranscriptSegment[]> {
    return loadTranscriptSegments(sessionId, from, to);
  }

  async analyze(sessionId: string, round: number, onProgress?: (pct: number) => Promise<void>): Promise<AnalyzeOutcome> {
    const { analyzer, logger } = this.deps;
    const session = await LiveSessionModel.findById(sessionId).lean();
    if (!session || session.status === SessionStatus.CANCELLED) return 'SKIPPED';
    const transcript = await TranscriptModel.findOne({ liveSessionId: sessionId }).select('+loudness').lean();
    if (!transcript) throw new UnrecoverableError('No transcript for this session; transcribe it first');

    await this.setStage(sessionId, ProcessingStage.ANALYZING);
    const base = (await this.deps.settings.getValues()).values.clips;
    // Phase 10: the session's category preset may set its own clip lengths.
    const preset = await new CategoryService({ settings: this.deps.settings }).presetFor(sessionId);
    const clips = {
      ...base,
      minDurationSeconds: preset.minDurationSeconds ?? base.minDurationSeconds,
      defaultDurationSeconds: preset.defaultDurationSeconds ?? base.defaultDurationSeconds,
      maxDurationSeconds: preset.maxDurationSeconds ?? base.maxDurationSeconds,
    };
    const streamer = await StreamerChannelModel.findById(session.streamerChannelId).select('displayName preferences.game').lean();
    const game = detectGame(streamer?.preferences?.game, session.title);
    const segments = await this.loadSegments(sessionId);
    const loudness = (transcript.loudness ?? []) as number[];
    const sourceSeconds = session.sourceMedia?.durationSeconds ?? transcript.durationSeconds ?? loudness.length;
    const bounds = { minSeconds: clips.minDurationSeconds, maxSeconds: clips.maxDurationSeconds, sourceSeconds };
    const stats = loudnessStats(loudness);
    const chat = await loadChatCounts(sessionId);
    const cStats = chatStats(chat);

    const raw: RawHighlight[] = [];
    let costUsd = 0;
    const windows: Array<[number, number]> = [];
    for (let s = 0; s < sourceSeconds; s += ANALYSIS_WINDOW_SECONDS - ANALYSIS_WINDOW_OVERLAP) {
      windows.push([s, Math.min(sourceSeconds, s + ANALYSIS_WINDOW_SECONDS)]);
      if (s + ANALYSIS_WINDOW_SECONDS >= sourceSeconds) break;
    }
    try {
      for (const [i, [from, to]] of windows.entries()) {
        if (to - from < clips.minDurationSeconds) continue;
        const res = await analyzer.analyze({
          streamTitle: session.title ?? '',
          streamerName: streamer?.displayName ?? 'the streamer',
          windowStartSeconds: from,
          windowEndSeconds: to,
          segments: segments.filter((s) => s.endSeconds > from && s.startSeconds < to),
          loudness,
          chat,
          game,
          clip: { minSeconds: clips.minDurationSeconds, maxSeconds: clips.maxDurationSeconds, targetSeconds: clips.defaultDurationSeconds },
          maxCandidates: Math.max(3, clips.maxClipsPerStream),
        });
        costUsd += res.costUsd;
        // Only trust timestamps inside the window the model actually saw.
        raw.push(...res.highlights.filter((h) => h.startSeconds < to && h.endSeconds > from));
        await onProgress?.(Math.round(((i + 1) / windows.length) * 90));
      }
    } catch (err) {
      if (costUsd) await LiveSessionModel.updateOne({ _id: sessionId }, { $inc: { estimatedCostUsd: costUsd } });
      throw asQueueError(err);
    }

    const heuristic = analyzer.name === 'heuristic';
    // Ad breaks, "be right back" screens and frozen video never make good Shorts.
    let staticRanges = ((transcript.staticRanges ?? []) as unknown as number[][]).map((r) => [r[0]!, r[1]!] as [number, number]);
    // A video that is mostly one still picture (podcast, audio over an image) is not "ads": keep everything.
    if (staticShare(staticRanges, 0, sourceSeconds) > 0.6) staticRanges = [];
    const normalized = raw
      .map((h) => normalizeHighlight(h, bounds, segments))
      .filter((h): h is RawHighlight => h !== null && staticShare(staticRanges, h.startSeconds, h.endSeconds) < 0.5)
      .map((h) => {
        const audio = audioScore(loudness, h.startSeconds, h.endSeconds, stats);
        const chatPts = chat.length ? chatScore(chat, h.startSeconds, h.endSeconds, cStats) : null;
        const score = blendSignals(h.score, { audio, audioWeight: heuristic ? 0 : AUDIO_WEIGHT, chat: chatPts, chatWeight: CHAT_WEIGHT });
        return { ...h, breakdown: { ...h.breakdown, audio, ...(chatPts === null ? {} : { chat: chatPts }) }, score };
      });

    // Keep clips a person picked or edited in Clip Studio; replace everything the AI chose before.
    const kept = await HighlightCandidateModel.find({ liveSessionId: sessionId, status: CandidateStatus.SELECTED, userAdjusted: true }).lean();
    const fresh = mergeHighlights(normalized, clips.maxDurationSeconds)
      .filter((c) => kept.every((k) => c.endSeconds <= k.startSeconds || c.startSeconds >= k.endSeconds))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_STORED_CANDIDATES);

    let selectSlots = Math.max(0, clips.maxClipsPerStream - kept.length);
    const docs = fresh.map((h) => {
      const above = h.score >= clips.minHighlightScore;
      const status = above && selectSlots-- > 0 ? CandidateStatus.SELECTED : above ? CandidateStatus.CANDIDATE : CandidateStatus.DISCARDED;
      return {
        liveSessionId: sessionId,
        startSeconds: h.startSeconds,
        endSeconds: h.endSeconds,
        keyMomentSeconds: h.keyMomentSeconds,
        score: h.score,
        scoreBreakdown: h.breakdown,
        reason: h.reason,
        hook: h.hook,
        reaction: h.reaction ?? null,
        commentQuestion: h.commentQuestion ?? null,
        momentType: h.momentType ?? null,
        topic: h.topic,
        transcriptExcerpt: excerpt(segments, h.startSeconds, h.endSeconds),
        status,
        discardReason: status === CandidateStatus.DISCARDED ? `Score ${h.score} is below the minimum (${clips.minHighlightScore})` : null,
        analysisProvider: analyzer.name,
        analysisRound: round,
      };
    });

    await HighlightCandidateModel.deleteMany({ liveSessionId: sessionId, _id: { $nin: kept.map((k) => k._id) } });
    if (docs.length) await HighlightCandidateModel.insertMany(docs);
    const selected = kept.length + docs.filter((d) => d.status === CandidateStatus.SELECTED).length;
    const candidates = docs.filter((d) => d.status === CandidateStatus.CANDIDATE).length;
    const discarded = docs.length - candidates - (selected - kept.length);

    await LiveSessionModel.updateOne(
      { _id: sessionId },
      {
        $set: {
          status: SessionStatus.HIGHLIGHTS_READY,
          processingStatus: ProcessingStatus.COMPLETED,
          processingStage: null,
          highlightCount: selected + candidates,
          lastError: selected + candidates === 0 ? `No moment scored above the minimum highlight score (${clips.minHighlightScore}). Lower it in Settings → Clips and press Reprocess.` : null,
        },
        $inc: { estimatedCostUsd: costUsd },
      },
    );
    logger?.info({ liveSessionId: sessionId, analyzer: analyzer.name, windows: windows.length, proposed: raw.length, selected, candidates, discarded, costUsd }, 'Highlights ready');
    return { selected, candidates, discarded };
  }

  /** Called when a step has exhausted its retries (or failed permanently). */
  async markFailed(sessionId: string, message: string) {
    await LiveSessionModel.updateOne(
      { _id: sessionId },
      { $set: { status: SessionStatus.FAILED, processingStatus: ProcessingStatus.FAILED, processingStage: null, lastError: message.slice(0, 500) } },
    );
  }

  private async setStage(sessionId: string, stage: ProcessingStage) {
    await LiveSessionModel.updateOne(
      { _id: sessionId },
      { $set: { status: SessionStatus.PROCESSING, processingStatus: ProcessingStatus.RUNNING, processingStage: stage, lastError: null } },
    );
  }
}

function excerpt(segments: TranscriptSegment[], start: number, end: number): string {
  const text = segments.filter((s) => s.endSeconds > start && s.startSeconds < end).map((s) => s.text).join(' ');
  return text.length > 600 ? `${text.slice(0, 597)}…` : text;
}

/** Hand-offs between pipeline stages; one job per (session, round, stage). */
export async function enqueueTranscription(queues: QueueRegistry, sessionId: string, round: number) {
  return enqueueTracked(queues, {
    jobType: JobType.TRANSCRIPTION,
    jobName: 'transcribe',
    key: idempotencyKey('session', sessionId, 'transcribe', round),
    entityType: 'LiveSession',
    entityId: sessionId,
    data: { liveSessionId: sessionId, round },
  });
}

export async function enqueueHighlightAnalysis(queues: QueueRegistry, sessionId: string, round: number) {
  return enqueueTracked(queues, {
    jobType: JobType.HIGHLIGHT_ANALYSIS,
    jobName: 'analyze-highlights',
    key: idempotencyKey('session', sessionId, 'highlights', round),
    entityType: 'LiveSession',
    entityId: sessionId,
    data: { liveSessionId: sessionId, round },
  });
}

/** Transcript segments overlapping [from, to), in order. */
export async function loadTranscriptSegments(sessionId: string, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<TranscriptSegment[]> {
  const chunks = await TranscriptChunkModel.find({ liveSessionId: sessionId, endSeconds: { $gt: from }, startSeconds: { $lt: to } })
    .sort({ index: 1 })
    .lean();
  return chunks
    .flatMap((c) => c.segments)
    .filter((s) => s.endSeconds > from && s.startSeconds < to)
    .map((s) => ({
      startSeconds: s.startSeconds,
      endSeconds: s.endSeconds,
      text: s.text,
      confidence: s.confidence ?? null,
      ...(s.words?.length ? { words: s.words.map((w) => ({ word: w.word ?? '', startSeconds: w.startSeconds ?? 0, endSeconds: w.endSeconds ?? 0 })) } : {}),
    }));
}

export async function enqueueRender(queues: QueueRegistry, sessionId: string, reason: string | number, force = false) {
  return enqueueTracked(queues, {
    jobType: JobType.CLIP_RENDER,
    jobName: 'render-clips',
    key: idempotencyKey('session', sessionId, 'render', reason),
    entityType: 'LiveSession',
    entityId: sessionId,
    data: { liveSessionId: sessionId, force },
  });
}
