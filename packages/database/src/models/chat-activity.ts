import mongoose, { type InferSchemaType, type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * Live-chat message rate for one session, sampled while it is live. Only
 * counts per 10-second bucket are kept (no message text or authors).
 */
const chatActivitySchema = new Schema(
  {
    liveSessionId: { type: Schema.Types.ObjectId, ref: 'LiveSession', required: true, unique: true },
    liveChatId: { type: String, default: null },
    pageToken: { type: String, default: null },
    /** Bucket 0 starts at the broadcast start. */
    anchorAt: { type: Date, required: true },
    bucketSeconds: { type: Number, default: 10 },
    counts: { type: [Number], default: [] },
    messageCount: { type: Number, default: 0 },
    status: { type: String, enum: ['ACTIVE', 'ENDED', 'UNAVAILABLE'], default: 'ACTIVE' },
    nextPollAt: { type: Date, default: () => new Date() },
    lastPolledAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

export type ChatActivity = InferSchemaType<typeof chatActivitySchema>;
export const ChatActivityModel: Model<ChatActivity> =
  (models.ChatActivity as Model<ChatActivity>) ?? model<ChatActivity>('ChatActivity', chatActivitySchema);
