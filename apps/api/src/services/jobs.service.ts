import { ProcessingJobModel } from '@shorts/database';
import { JobStatus, JobType, enumValues, paginationQuerySchema, type Paginated, type ProcessingJobDTO } from '@shorts/shared-types';
import { z } from 'zod';
import { mongoose } from '@shorts/database';
import { AppError } from '../errors';

export const jobListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(enumValues(JobStatus) as [JobStatus, ...JobStatus[]]).optional(),
  jobType: z.enum(enumValues(JobType) as [JobType, ...JobType[]]).optional(),
});
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

type JobDoc = {
  _id: unknown;
  jobType: string;
  queueName: string;
  entityType?: string | null;
  entityId?: unknown;
  status: string;
  attempts: number;
  maxAttempts: number;
  progress: number;
  lastError?: string | null;
  errorCode?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const toDTO = (j: JobDoc): ProcessingJobDTO => ({
  id: String(j._id),
  jobType: j.jobType as JobType,
  queueName: j.queueName,
  entityType: j.entityType ?? null,
  entityId: j.entityId ? String(j.entityId) : null,
  status: j.status as JobStatus,
  attempts: j.attempts,
  maxAttempts: j.maxAttempts,
  progress: j.progress,
  lastError: j.lastError ?? null,
  errorCode: j.errorCode ?? null,
  startedAt: j.startedAt ? j.startedAt.toISOString() : null,
  completedAt: j.completedAt ? j.completedAt.toISOString() : null,
  createdAt: j.createdAt.toISOString(),
  updatedAt: j.updatedAt.toISOString(),
});

export async function listJobs(q: JobListQuery): Promise<Paginated<ProcessingJobDTO>> {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.jobType) filter.jobType = q.jobType;
  const [items, total] = await Promise.all([
    ProcessingJobModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .lean(),
    ProcessingJobModel.countDocuments(filter),
  ]);
  return { items: (items as unknown as JobDoc[]).map(toDTO), page: q.page, pageSize: q.pageSize, total };
}

export async function getJob(id: string): Promise<ProcessingJobDTO> {
  if (!mongoose.isValidObjectId(id)) throw AppError.notFound('Job not found');
  const job = await ProcessingJobModel.findById(id).lean();
  if (!job) throw AppError.notFound('Job not found');
  return toDTO(job as unknown as JobDoc);
}
