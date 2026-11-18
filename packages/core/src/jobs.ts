import { ProcessingJobModel } from '@shorts/database';
import { DEFAULT_JOB_OPTIONS, type QueueRegistry } from '@shorts/queue';
import { JobStatus, QUEUE_NAMES, type JobType } from '@shorts/shared-types';
import { isDuplicateKeyError } from './errors';

export interface EnqueueTrackedOptions {
  jobType: JobType;
  jobName: string;
  /** Stable idempotency key; also used as the BullMQ job id. */
  key: string;
  entityType: string;
  entityId: string;
  data?: Record<string, unknown>;
}

/**
 * Enqueue a pipeline job exactly once (spec §13 "stable idempotency keys").
 *
 * The durable guard is the unique `ProcessingJob.idempotencyKey` in MongoDB —
 * BullMQ forgets job ids once jobs are cleaned up. Returns `false` when the
 * job was already enqueued earlier.
 */
export async function enqueueTracked(queues: QueueRegistry, opts: EnqueueTrackedOptions): Promise<boolean> {
  const queueName = QUEUE_NAMES[opts.jobType];
  const recordKey = `${queueName}__${opts.key}`;
  try {
    const res = await ProcessingJobModel.updateOne(
      { idempotencyKey: recordKey },
      {
        $setOnInsert: {
          idempotencyKey: recordKey,
          jobType: opts.jobType,
          queueName,
          bullJobId: opts.key,
          entityType: opts.entityType,
          entityId: opts.entityId,
          status: JobStatus.PENDING,
          maxAttempts: DEFAULT_JOB_OPTIONS.attempts ?? 3,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount === 0) return false;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false; // concurrent duplicate lost the race
    throw err;
  }

  try {
    await queues.enqueue(queueName, opts.jobName, { entityType: opts.entityType, entityId: opts.entityId, ...opts.data }, opts.key);
  } catch (err) {
    // Roll back the record so a retry can enqueue again.
    await ProcessingJobModel.deleteOne({ idempotencyKey: recordKey }).catch(() => undefined);
    throw err;
  }
  return true;
}
