import mongoose, { type InferSchemaType, type Model } from 'mongoose';

const { Schema, model, models } = mongoose;

/**
 * Phase 10: what Shorts of one category look like and where they go.
 * `_id` is the category (GAMING, IRL, ...). Empty / null fields follow Settings.
 */
const categoryPresetSchema = new Schema(
  {
    _id: { type: String, required: true },
    shortStyle: { type: String, default: null },
    captionStyle: { type: String, default: null },
    hookOverlay: { type: String, default: null },
    minDurationSeconds: { type: Number, default: null },
    defaultDurationSeconds: { type: Number, default: null },
    maxDurationSeconds: { type: Number, default: null },
    hashtags: { type: String, default: null },
    descriptionFooter: { type: String, default: null },
    /** Add this category's Shorts to its own YouTube playlist. */
    playlist: { type: String, enum: ['ON', 'OFF'], default: 'ON' },
    /** Created automatically on the first upload. */
    playlistId: { type: String, default: null },
  },
  { timestamps: true },
);

export type CategoryPreset = InferSchemaType<typeof categoryPresetSchema>;
export const CategoryPresetModel: Model<CategoryPreset> = (models.CategoryPreset as Model<CategoryPreset>) ?? model<CategoryPreset>('CategoryPreset', categoryPresetSchema);
