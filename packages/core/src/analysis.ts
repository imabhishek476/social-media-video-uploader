import fsp from 'node:fs/promises';
import path from 'node:path';
import { HighlightCandidateModel, LiveSessionModel, StreamerChannelModel, TranscriptChunkModel, TranscriptModel, mongoose } from '@shorts/database';
import {
  AiProviderError,
  audioScore,
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
import { extractAudioChunks, measureLoudness } from './audio';
import { blendScore, mergeHighlights, normalizeHighlight } from './highlights';
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

  async transcribe(sessionId: string, onProgress?: (pct: number) => Promise<void>): Promise<TranscribeOutcome> {
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

      const [chunks, loudness] = await Promise.all([extractAudioChunks(local, path.join(work, 'audio'), transcription.maxFileBytes), measureLoudness(local)]);
      await fsp.rm(local, { force: true }); // the video is no longer needed for this step
      await onProgress?.(25);

      const segments: TranscriptSegment[] = [];
      let language = this.deps.language ?? 'en';
      let audioSeconds = 0;
      for (const [i, chunk] of chunks.entries()) {
        const out = await transcription.transcribe(chunk.path, { language: this.deps.language, durationSeconds: chunk.durationSeconds });
        language = out.language || language;
        audioSeconds += chunk.durationSeconds;
        for (const s of out.segments) {
          segments.push({ ...s, startSeconds: s.startSeconds + chunk.offsetSeconds, endSeconds: Math.min(s.endSeconds, chunk.durationSeconds) + chunk.offsetSeconds });
        }
        await onProgress?.(25 + Math.round(((i + 1) / chunks.length) * 70));
      }
      const costUsd = (audioSeconds / 60) * transcription.costPerMinuteUsd;
      await this.saveTranscript(sessionId, { provider: transcription.name, language, durationSeconds: Math.round(audioSeconds), segments, loudness, costUsd });
      await LiveSessionModel.updateOne({ _id: sessionId }, { $inc: { estimatedCostUsd: costUsd } });
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
    t: { provider: string; language: string; durationSeconds: number; segments: TranscriptSegment[]; loudness: number[]; costUsd: number },
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
    const { clips } = (await this.deps.settings.getValues()).values;
    const streamer = await StreamerChannelModel.findById(session.streamerChannelId).select('displayName').lean();
    const segments = await this.loadSegments(sessionId);
    const loudness = (transcript.loudness ?? []) as number[];
    const sourceSeconds = session.sourceMedia?.durationSeconds ?? transcript.durationSeconds ?? loudness.length;
    const bounds = { minSeconds: clips.minDurationSeconds, maxSeconds: clips.maxDurationSeconds, sourceSeconds };
    const stats = loudnessStats(loudness);

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
    const normalized = raw
      .map((h) => normalizeHighlight(h, bounds, segments))
      .filter((h): h is RawHighlight => h !== null)
      .map((h) => {
        const audio = audioScore(loudness, h.startSeconds, h.endSeconds, stats);
        return { ...h, breakdown: { ...h.breakdown, audio }, score: heuristic ? h.score : blendScore(h.score, audio, AUDIO_WEIGHT) };
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
    .map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, text: s.text, confidence: s.confidence ?? null }));
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
