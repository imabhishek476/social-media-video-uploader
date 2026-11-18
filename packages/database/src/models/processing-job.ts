import mongoose, { type InferSchemaType, type Model } from 'mongoose';
import { JobStatus, JobType, enumValues } from '@shorts/shared-types';

// mongoose is CommonJS: use the default export so native ESM builds resolve it.
const { Schema, model, models } = mongoose;

/**
 * Durable mirror of BullMQ jobs, used by the Job Monitor and as the
 * long-lived idempotency guard (BullMQ forgets job IDs once jobs are removed).
 */
const processingJobSchema = new Schema(
  {
    jobType: { type: String, enum: enumValues(JobType), required: true },
    queueName: { type: String, required: true },
    bullJobId: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
    entityType: { type: String, default: null },
    entityId: { type: Schema.Types.ObjectId, default: null },
    status: { type: String, enum: enumValues(JobStatus), default: JobStatus.PENDING },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    lastError: { type: String, default: null },
    errorCode: { type: String, default: null },
    workerId: { type: String, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

processingJobSchema.index({ idempotencyKey: 1 }, { unique: true });
processingJobSchema.index({ status: 1, updatedAt: -1 });
processingJobSchema.index({ jobType: 1, createdAt: -1 });
processingJobSchema.index({ entityType: 1, entityId: 1 });
processingJobSchema.index({ createdAt: -1 });

export type ProcessingJob = InferSchemaType<typeof processingJobSchema>;
export const ProcessingJobModel: Model<ProcessingJob> =
  (models.ProcessingJob as Model<ProcessingJob>) ?? model<ProcessingJob>('ProcessingJob', processingJobSchema);
