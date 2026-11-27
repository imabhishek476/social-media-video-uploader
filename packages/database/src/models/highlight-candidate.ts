import mongoose, { type InferSchemaType, type Model } from 'mongoose';
import { CandidateStatus, enumValues } from '@shorts/shared-types';

// mongoose is CommonJS: use the default export so native ESM builds resolve it.
const { Schema, model, models } = mongoose;

const scoreBreakdownSchema = new Schema(
  {
    emotion: Number,
    entertainment: Number,
    context: Number,
    hook: Number,
    audio: Number,
    chat: Number,
    payoff: Number,
    clarity: Number,
    pacing: Number,
  },
  { _id: false },
);

const highlightCandidateSchema = new Schema(
  {
    liveSessionId: { type: Schema.Types.ObjectId, ref: 'LiveSession', required: true },
    startSeconds: { type: Number, required: true, min: 0 },
    endSeconds: { type: Number, required: true, min: 0 },
    keyMomentSeconds: { type: Number, default: null },
    score: { type: Number, required: true, min: 0, max: 100 },
    scoreBreakdown: { type: scoreBreakdownSchema, default: () => ({}) },
    reason: { type: String, default: '' },
    hook: { type: String, default: '' },
    reaction: { type: String, default: null },
    commentQuestion: { type: String, default: null },
    momentType: { type: String, default: null },
    topic: { type: String, default: null },
    transcriptExcerpt: { type: String, default: '' },
    status: { type: String, enum: enumValues(CandidateStatus), default: CandidateStatus.CANDIDATE },
    discardReason: { type: String, default: null },
    analysisProvider: { type: String, default: null },
    /** Which analysis run produced it (session.reprocessCount at the time). */
    analysisRound: { type: Number, default: 0 },
    /** Selected, discarded or trimmed by a person in Clip Studio (survives re-analysis when selected). */
    userAdjusted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

highlightCandidateSchema.index({ liveSessionId: 1, score: -1 });
highlightCandidateSchema.index({ liveSessionId: 1, status: 1 });

export type HighlightCandidate = InferSchemaType<typeof highlightCandidateSchema>;
export const HighlightCandidateModel: Model<HighlightCandidate> =
  (models.HighlightCandidate as Model<HighlightCandidate>) ??
  model<HighlightCandidate>('HighlightCandidate', highlightCandidateSchema);
