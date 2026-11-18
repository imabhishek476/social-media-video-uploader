import mongoose, { type InferSchemaType, type Model } from 'mongoose';
import { UserRole, enumValues } from '@shorts/shared-types';

// mongoose is CommonJS: use the default export so native ESM builds resolve it.
const { Schema, model, models } = mongoose;

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: enumValues(UserRole), default: UserRole.ADMIN, required: true },
    disabled: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

export type User = InferSchemaType<typeof userSchema>;
export const UserModel: Model<User> = (models.User as Model<User>) ?? model<User>('User', userSchema);
