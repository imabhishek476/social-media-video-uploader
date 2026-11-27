import { HighlightCandidateModel, LiveSessionModel, TranscriptChunkModel, TranscriptModel, mongoose } from '@shorts/database';
import { CandidateStatus, type CandidateUpdateInput, type HighlightCandidateDTO, type TranscriptDTO } from '@shorts/shared-types';
import { DomainError } from './errors';
import type { SettingsService } from './settings';

/** Clip Studio: review and adjust highlight candidates (spec §16). */
export class CandidateService {
  constructor(private readonly settings: SettingsService) {}

  async listForSession(sessionId: string): Promise<HighlightCandidateDTO[]> {
    if (!mongoose.isValidObjectId(sessionId)) throw DomainError.notFound('Live session');
    const items = await HighlightCandidateModel.find({ liveSessionId: sessionId }).sort({ score: -1 }).lean();
    return items.map(toCandidateDTO);
  }

  async update(id: string, input: CandidateUpdateInput): Promise<HighlightCandidateDTO> {
    if (!mongoose.isValidObjectId(id)) throw DomainError.notFound('Highlight');
    const c = await HighlightCandidateModel.findById(id).lean();
    if (!c) throw DomainError.notFound('Highlight');
    const session = await LiveSessionModel.findById(c.liveSessionId).select('sourceMedia.durationSeconds').lean();
    const { clips } = (await this.settings.getValues()).values;

    const set: Record<string, unknown> = {};
    // Length rules only apply to a trim. Select / Discard / Restore must work even on
    // highlights made before the length limits changed.
    if (input.startSeconds !== undefined || input.endSeconds !== undefined) {
      const start = input.startSeconds ?? c.startSeconds;
      const end = input.endSeconds ?? c.endSeconds;
      const sourceSeconds = session?.sourceMedia?.durationSeconds ?? Infinity;
      if (end <= start) throw new DomainError('VALIDATION_FAILED', 'End must be after start', 400);
      if (end > sourceSeconds + 0.5) throw new DomainError('VALIDATION_FAILED', `End is past the end of the recording (${Math.round(sourceSeconds)}s)`, 400);
      // Trimming below the configured minimum is allowed (a person decided); exceeding the maximum is not.
      if (end - start > clips.maxDurationSeconds + 0.05) {
        throw new DomainError('VALIDATION_FAILED', `Clip is ${Math.round(end - start)}s; the maximum is ${clips.maxDurationSeconds}s`, 400);
      }
      if (end - start < 5) throw new DomainError('VALIDATION_FAILED', 'Clip must be at least 5 seconds', 400);
      Object.assign(set, { userAdjusted: true, startSeconds: Math.round(start * 10) / 10, endSeconds: Math.round(end * 10) / 10 });
    }
    if (input.status) {
      set.status = input.status;
      set.discardReason = input.status === CandidateStatus.DISCARDED ? (input.discardReason ?? 'Discarded in Clip Studio') : null;
    }
    const updated = await HighlightCandidateModel.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
    await this.refreshCount(String(c.liveSessionId));
    return toCandidateDTO(updated!);
  }

  async transcript(sessionId: string, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<TranscriptDTO> {
    if (!mongoose.isValidObjectId(sessionId)) throw DomainError.notFound('Live session');
    const t = await TranscriptModel.findOne({ liveSessionId: sessionId }).lean();
    if (!t) throw DomainError.notFound('Transcript');
    const chunks = await TranscriptChunkModel.find({ transcriptId: t._id, endSeconds: { $gt: from }, startSeconds: { $lt: to } }).sort({ index: 1 }).lean();
    return {
      liveSessionId: sessionId,
      provider: t.provider,
      language: t.language,
      durationSeconds: t.durationSeconds ?? null,
      segmentCount: t.segmentCount,
      segments: chunks
        .flatMap((c) => c.segments)
        .filter((s) => s.endSeconds > from && s.startSeconds < to)
        .map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, text: s.text })),
    };
  }

  private async refreshCount(sessionId: string) {
    const highlightCount = await HighlightCandidateModel.countDocuments({ liveSessionId: sessionId, status: { $ne: CandidateStatus.DISCARDED } });
    await LiveSessionModel.updateOne({ _id: sessionId }, { $set: { highlightCount } });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toCandidateDTO(c: any): HighlightCandidateDTO {
  return {
    id: String(c._id),
    liveSessionId: String(c.liveSessionId),
    startSeconds: c.startSeconds,
    endSeconds: c.endSeconds,
    durationSeconds: Math.round((c.endSeconds - c.startSeconds) * 10) / 10,
    keyMomentSeconds: c.keyMomentSeconds ?? null,
    score: c.score,
    scoreBreakdown: Object.fromEntries(Object.entries(c.scoreBreakdown ?? {}).filter(([, v]) => typeof v === 'number')) as Record<string, number>,
    reason: c.reason ?? '',
    hook: c.hook ?? '',
    topic: c.topic ?? null,
    transcriptExcerpt: c.transcriptExcerpt ?? '',
    status: c.status,
    discardReason: c.discardReason ?? null,
    analysisProvider: c.analysisProvider ?? null,
    userAdjusted: Boolean(c.userAdjusted),
    createdAt: c.createdAt.toISOString(),
  };
}
