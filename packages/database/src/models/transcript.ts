import mongoose, { type InferSchemaType, type Model } from 'mongoose';

// mongoose is CommonJS: use the default export so native ESM builds resolve it.
const { Schema, model, models } = mongoose;

/**
 * Transcript header document. Segments are stored in chunked
 * `TranscriptChunk` documents so multi-hour streams never approach the 16MB
 * MongoDB document limit (spec §11 note).
 */
const transcriptSchema = new Schema(
  {
    liveSessionId: { type: Schema.Types.ObjectId, ref: 'LiveSession', required: true },
    language: { type: String, default: 'en' },
    provider: { type: String, required: true },
    durationSeconds: { type: Number, default: null },
    segmentCount: { type: Number, default: 0 },
    chunkCount: { type: Number, default: 0 },
    /** Loudness per second of audio (dBFS), used to score highlights. */
    loudness: { type: [Number], default: [], select: false },
    /** [start, end] seconds where the picture is static (ads, BRB screens); clips there are dropped. */
    staticRanges: { type: [[Number]], default: [] },
    costUsd: { type: Number, default: 0 },
    /** Optional full transcript in object storage (e.g. JSON/VTT). */
    storageKey: { type: String, default: null },
  },
  { timestamps: true },
);
transcriptSchema.index({ liveSessionId: 1 }, { unique: true });

const segmentSchema = new Schema(
  {
    startSeconds: { type: Number, required: true },
    endSeconds: { type: Number, required: true },
    text: { type: String, required: true },
    confidence: { type: Number, default: null },
    speaker: { type: String, default: null },
    words: {
      type: [{ _id: false, word: String, startSeconds: Number, endSeconds: Number, confidence: Number }],
      default: undefined,
    },
  },
  { _id: false },
);

const transcriptChunkSchema = new Schema(
  {
    transcriptId: { type: Schema.Types.ObjectId, ref: 'Transcript', required: true },
    liveSessionId: { type: Schema.Types.ObjectId, ref: 'LiveSession', required: true },
    index: { type: Number, required: true },
    startSeconds: { type: Number, required: true },
    endSeconds: { type: Number, required: true },
    segments: { type: [segmentSchema], default: [] },
  },
  { timestamps: true },
);
transcriptChunkSchema.index({ transcriptId: 1, index: 1 }, { unique: true });
transcriptChunkSchema.index({ liveSessionId: 1, startSeconds: 1 });

export type Transcript = InferSchemaType<typeof transcriptSchema>;
export type TranscriptChunk = InferSchemaType<typeof transcriptChunkSchema>;

export const TranscriptModel: Model<Transcript> =
  (models.Transcript as Model<Transcript>) ?? model<Transcript>('Transcript', transcriptSchema);
export const TranscriptChunkModel: Model<TranscriptChunk> =
  (models.TranscriptChunk as Model<TranscriptChunk>) ?? model<TranscriptChunk>('TranscriptChunk', transcriptChunkSchema);
