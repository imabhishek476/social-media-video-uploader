import mongoose, { type InferSchemaType, type Model } from 'mongoose';

// mongoose is CommonJS: use the default export so native ESM builds resolve it.
const { Schema, model, models } = mongoose;

/**
 * Singleton settings document (key = "global"). Non-secret configuration
 * only; validated by `appSettingsSchema` in @shorts/shared-types. Secrets
 * live in `IntegrationCredential`, encrypted.
 */
const appSettingsSchema = new Schema(
  {
    key: { type: String, required: true, default: 'global' },
    values: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false },
);
appSettingsSchema.index({ key: 1 }, { unique: true });

export type AppSettingsDoc = InferSchemaType<typeof appSettingsSchema>;
export const AppSettingsModel: Model<AppSettingsDoc> =
  (models.AppSettings as Model<AppSettingsDoc>) ?? model<AppSettingsDoc>('AppSettings', appSettingsSchema);

/** Encrypted OAuth credentials for the central destination channel (spec §15). */
const integrationCredentialSchema = new Schema(
  {
    provider: { type: String, required: true },
    accountId: { type: String, default: null },
    accountTitle: { type: String, default: null },
    scopes: { type: [String], default: [] },
    encryptedRefreshToken: { type: String, required: true, select: false },
    /** For providers whose stored token itself expires (Instagram long-lived tokens). */
    tokenExpiresAt: { type: Date, default: null },
    status: { type: String, enum: ['ACTIVE', 'REVOKED', 'ERROR'], default: 'ACTIVE' },
    lastError: { type: String, default: null },
    connectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    connectedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
integrationCredentialSchema.index({ provider: 1 }, { unique: true });

export type IntegrationCredential = InferSchemaType<typeof integrationCredentialSchema>;
export const IntegrationCredentialModel: Model<IntegrationCredential> =
  (models.IntegrationCredential as Model<IntegrationCredential>) ??
  model<IntegrationCredential>('IntegrationCredential', integrationCredentialSchema);
