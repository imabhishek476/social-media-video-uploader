import mongoose, { type InferSchemaType, type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * Weekly "best of" long video built from the week's published Shorts
 * (Phase 8.5). One per week (`weekKey` = YYYY-MM-DD of the build day).
 */
const compilationSchema = new Schema(
  {
    weekKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ['BUILDING', 'UPLOADING', 'PUBLISHED', 'SKIPPED', 'FAILED'], default: 'BUILDING' },
    clipIds: { type: [Schema.Types.ObjectId], default: [] },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    durationSeconds: { type: Number, default: null },
    storageKey: { type: String, default: null },
    resumableUploadUrl: { type: String, default: null, select: false },
    youtubeVideoId: { type: String, default: null },
    youtubeUrl: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

export type Compilation = InferSchemaType<typeof compilationSchema>;
export const CompilationModel: Model<Compilation> = (models.Compilation as Model<Compilation>) ?? model<Compilation>('Compilation', compilationSchema);
