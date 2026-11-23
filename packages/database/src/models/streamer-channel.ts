import mongoose, { type InferSchemaType, type Model } from 'mongoose';
import { LiveStatus, enumValues } from '@shorts/shared-types';

// mongoose is CommonJS: use the default export so native ESM builds resolve it.
const { Schema, model, models } = mongoose;

/** Per-channel overrides; `null`/missing values fall back to global settings. */
const preferencesSchema = new Schema(
  {
    maxClipsPerStream: { type: Number, default: null },
    minHighlightScore: { type: Number, default: null },
    minClipDurationSeconds: { type: Number, default: null },
    maxClipDurationSeconds: { type: Number, default: null },
    language: { type: String, default: null },
    /** Game this streamer plays, if fixed (otherwise read from each stream title). */
    game: { type: String, default: null },
  },
  { _id: false },
);

const streamerChannelSchema = new Schema(
  {
    channelId: { type: String, required: true, trim: true },
    channelUrl: { type: String, required: true, trim: true },
    handle: { type: String, default: null },
    displayName: { type: String, required: true, trim: true },
    thumbnailUrl: { type: String, default: null },
    tags: { type: [String], default: [] },
    /** Broadcasts whose session was deleted: the monitor must not re-create them. */
    ignoredBroadcastIds: { type: [String], default: [] },
    category: { type: String, default: null },
    monitoringEnabled: { type: Boolean, default: true },
    liveStatus: { type: String, enum: enumValues(LiveStatus), default: LiveStatus.UNKNOWN },
    currentLiveTitle: { type: String, default: null },
    currentLiveSessionId: { type: Schema.Types.ObjectId, ref: 'LiveSession', default: null },
    lastCheckedAt: { type: Date, default: null },
    nextCheckAt: { type: Date, default: () => new Date() },
    lastLiveAt: { type: Date, default: null },
    lastLiveSessionId: { type: Schema.Types.ObjectId, ref: 'LiveSession', default: null },
    totalSessions: { type: Number, default: 0 },
    totalProcessedStreams: { type: Number, default: 0 },
    consecutiveCheckFailures: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    preferences: { type: preferencesSchema, default: () => ({}) },
    /**
     * Streams that *started* before this moment are never processed — so
     * registering (or resuming) a channel doesn't backfill its old VODs.
     */
    monitoringSince: { type: Date, default: () => new Date() },
    /** Claim token so concurrent monitor ticks never check the same channel twice. */
    checkLeaseId: { type: String, default: null },
    /** Soft delete keeps session/clip history intact (spec §12 "according to retention policy"). */
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

streamerChannelSchema.index({ channelId: 1 }, { unique: true });
// Monitor worker query: enabled channels due for a check.
streamerChannelSchema.index({ monitoringEnabled: 1, nextCheckAt: 1 });
streamerChannelSchema.index({ checkLeaseId: 1 }, { sparse: true });
streamerChannelSchema.index({ deletedAt: 1, displayName: 1 });
streamerChannelSchema.index({ liveStatus: 1 });

export type StreamerChannel = InferSchemaType<typeof streamerChannelSchema>;
export const StreamerChannelModel: Model<StreamerChannel> =
  (models.StreamerChannel as Model<StreamerChannel>) ?? model<StreamerChannel>('StreamerChannel', streamerChannelSchema);
