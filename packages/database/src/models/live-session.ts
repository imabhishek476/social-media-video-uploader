import mongoose, { type InferSchemaType, type Model } from 'mongoose';
import { ProcessingStatus, SessionStatus, SourceMediaStatus, enumValues } from '@shorts/shared-types';

// mongoose is CommonJS: use the default export so native ESM builds resolve it.
const { Schema, model, models } = mongoose;

const sourceMediaSchema = new Schema(
  {
    provider: { type: String, default: null },
    status: { type: String, enum: enumValues(SourceMediaStatus), default: SourceMediaStatus.PENDING },
    storageKey: { type: String, default: null },
    fileSizeBytes: { type: Number, default: null },
    durationSeconds: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    frameRate: { type: Number, default: null },
    hasAudio: { type: Boolean, default: null },
    videoCodec: { type: String, default: null },
    readyAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    /** Live progress while a long download runs (cleared when done). */
    progress: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const liveSessionSchema = new Schema(
  {
    streamerChannelId: { type: Schema.Types.ObjectId, ref: 'StreamerChannel', required: true },
    broadcastId: { type: String, required: true },
    title: { type: String, default: '' },
    status: { type: String, enum: enumValues(SessionStatus), default: SessionStatus.DETECTED },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: null },
    lastObservedLiveAt: { type: Date, default: null },
    /** Consecutive "not live" observations; ended only after N (spec §6 Workflow C). */
    endConfirmationCount: { type: Number, default: 0 },
    sourceMedia: { type: sourceMediaSchema, default: () => ({}) },
    processingStatus: { type: String, enum: enumValues(ProcessingStatus), default: ProcessingStatus.NOT_STARTED },
    /** Current step while PROCESSING (TRANSCRIBING / ANALYZING). */
    processingStage: { type: String, default: null },
    highlightCount: { type: Number, default: 0 },
    /** Webcam overlay position (0–1 of the frame) for the facecam + gameplay layout. */
    facecam: {
      type: new Schema(
        { x: Number, y: Number, w: Number, h: Number, source: { type: String, enum: ['detected', 'manual', 'none'] }, detectedAt: Date },
        { _id: false },
      ),
      default: null,
    },
    /** Layout for this session's Shorts (set by "Re-render with layout"); null = Settings. */
    reframingMode: { type: String, default: null },
    clipCount: { type: Number, default: 0 },
    estimatedCostUsd: { type: Number, default: 0 },
    /** How the end was established: provider end time, N confirmations, or admin action. */
    endReason: { type: String, default: null },
    /** Bumped on each manual reprocess; part of the processing idempotency key. */
    reprocessCount: { type: Number, default: 0 },
    nextWatchAt: { type: Date, default: () => new Date() },
    watchLeaseId: { type: String, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

liveSessionSchema.index({ streamerChannelId: 1, broadcastId: 1 }, { unique: true });
liveSessionSchema.index({ status: 1, nextWatchAt: 1 });
liveSessionSchema.index({ watchLeaseId: 1 }, { sparse: true });
liveSessionSchema.index({ streamerChannelId: 1, createdAt: -1 });
liveSessionSchema.index({ status: 1, updatedAt: -1 });
liveSessionSchema.index({ createdAt: -1 });

export type LiveSession = InferSchemaType<typeof liveSessionSchema>;
export const LiveSessionModel: Model<LiveSession> =
  (models.LiveSession as Model<LiveSession>) ?? model<LiveSession>('LiveSession', liveSessionSchema);
