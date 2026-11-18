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
    topic: { type: String, default: null },
    transcriptExcerpt: { type: String, default: '' },
    status: { type: String, enum: enumValues(CandidateStatus), default: CandidateStatus.CANDIDATE },
    discardReason: { type: String, default: null },
    analysisProvider: { type: String, default: null },
  },
  { timestamps: true },
);

highlightCandidateSchema.index({ liveSessionId: 1, score: -1 });
highlightCandidateSchema.index({ liveSessionId: 1, status: 1 });

export type HighlightCandidate = InferSchemaType<typeof highlightCandidateSchema>;
export const HighlightCandidateModel: Model<HighlightCandidate> =
  (models.HighlightCandidate as Model<HighlightCandidate>) ??
  model<HighlightCandidate>('HighlightCandidate', highlightCandidateSchema);
