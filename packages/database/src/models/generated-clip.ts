import mongoose, { type InferSchemaType, type Model } from 'mongoose';
import { ApprovalStatus, ReframingMode, RenderStatus, UploadStatus, enumValues } from '@shorts/shared-types';

// mongoose is CommonJS: use the default export so native ESM builds resolve it.
const { Schema, model, models } = mongoose;

const generatedClipSchema = new Schema(
  {
    liveSessionId: { type: Schema.Types.ObjectId, ref: 'LiveSession', required: true },
    streamerChannelId: { type: Schema.Types.ObjectId, ref: 'StreamerChannel', required: true },
    highlightCandidateId: { type: Schema.Types.ObjectId, ref: 'HighlightCandidate', required: true },
    startSeconds: { type: Number, required: true },
    endSeconds: { type: Number, required: true },
    durationSeconds: { type: Number, required: true },
    highlightScore: { type: Number, default: null },
    reframingMode: { type: String, enum: enumValues(ReframingMode), default: ReframingMode.CENTER_CROP },

    storageKey: { type: String, default: null },
    thumbnailKey: { type: String, default: null },
    subtitleKey: { type: String, default: null },
    renderStatus: { type: String, enum: enumValues(RenderStatus), default: RenderStatus.PENDING },
    renderVersion: { type: Number, default: 1 },

    title: { type: String, default: '' },
    description: { type: String, default: '' },
    tags: { type: [String], default: [] },
    metadataEditedByUser: { type: Boolean, default: false },

    approvalStatus: { type: String, enum: enumValues(ApprovalStatus), default: ApprovalStatus.PENDING },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    uploadStatus: { type: String, enum: enumValues(UploadStatus), default: UploadStatus.NOT_UPLOADED },
    /** Stable key reused across retries so an upload is never duplicated (spec §6 Workflow G). */
    uploadIdempotencyKey: { type: String, default: null },
    uploadAttempts: { type: Number, default: 0 },
    resumableUploadUrl: { type: String, default: null, select: false },
    scheduledPublishAt: { type: Date, default: null },
    youtubeVideoId: { type: String, default: null },
    youtubeUrl: { type: String, default: null },
    publishedAt: { type: Date, default: null },

    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

generatedClipSchema.index({ highlightCandidateId: 1, renderVersion: 1 }, { unique: true });
generatedClipSchema.index(
  { youtubeVideoId: 1 },
  { unique: true, partialFilterExpression: { youtubeVideoId: { $type: 'string' } } },
);
generatedClipSchema.index(
  { uploadIdempotencyKey: 1 },
  { unique: true, partialFilterExpression: { uploadIdempotencyKey: { $type: 'string' } } },
);
generatedClipSchema.index({ liveSessionId: 1, createdAt: -1 });
generatedClipSchema.index({ approvalStatus: 1, uploadStatus: 1 });
generatedClipSchema.index({ publishedAt: -1 });

export type GeneratedClip = InferSchemaType<typeof generatedClipSchema>;
export const GeneratedClipModel: Model<GeneratedClip> =
  (models.GeneratedClip as Model<GeneratedClip>) ?? model<GeneratedClip>('GeneratedClip', generatedClipSchema);
