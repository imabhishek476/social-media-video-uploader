import mongoose, { type InferSchemaType, type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

/** Autopilot on/off state (Phase 9). One document, `_id` = "main". */
const autopilotStateSchema = new Schema(
  {
    _id: { type: String, default: 'main' },
    paused: { type: Boolean, default: false },
    pausedReason: { type: String, default: null },
    pausedAt: { type: Date, default: null },
    /** Upload failures of auto-approved Shorts in a row; pauses autopilot at the limit. */
    consecutiveFailures: { type: Number, default: 0 },
  },
  { timestamps: true },
);

/** Every automatic decision, with the reason, for the Activity page. */
const autopilotEventSchema = new Schema(
  {
    kind: { type: String, enum: ['PUBLISHED', 'HELD', 'PAUSED', 'RESUMED'], required: true },
    clipId: { type: Schema.Types.ObjectId, default: null, index: true },
    liveSessionId: { type: Schema.Types.ObjectId, default: null },
    title: { type: String, default: '' },
    score: { type: Number, default: null },
    reasons: { type: [String], default: [] },
    by: { type: String, default: 'autopilot' },
  },
  { timestamps: true },
);
autopilotEventSchema.index({ createdAt: -1 });
// Keep about 90 days of history.
autopilotEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400, name: 'autopilot_event_ttl' });

export type AutopilotState = InferSchemaType<typeof autopilotStateSchema>;
export type AutopilotEvent = InferSchemaType<typeof autopilotEventSchema>;
export const AutopilotStateModel: Model<AutopilotState> = (models.AutopilotState as Model<AutopilotState>) ?? model<AutopilotState>('AutopilotState', autopilotStateSchema);
export const AutopilotEventModel: Model<AutopilotEvent> = (models.AutopilotEvent as Model<AutopilotEvent>) ?? model<AutopilotEvent>('AutopilotEvent', autopilotEventSchema);
