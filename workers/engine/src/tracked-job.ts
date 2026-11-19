import { ProcessingJobModel } from '@shorts/database';
import type { Logger } from '@shorts/observability';
import { DelayedError, UnrecoverableError, type Job } from '@shorts/queue';
import { JobStatus, jobTypeForQueue, type QueueName } from '@shorts/shared-types';

/** Payload fields every pipeline job carries so it can be mirrored to MongoDB. */
export interface TrackedJobData {
  entityType?: string;
  entityId?: string;
}

export interface JobContext {
  job: Job;
  logger: Logger;
  reportProgress: (percent: number) => Promise<void>;
  /** Re-run this job at `until` without counting a failed attempt. */
  defer: (until: Date, reason: string) => Promise<never>;
}

export type TrackedHandler<T extends TrackedJobData, R> = (data: T, ctx: JobContext) => Promise<R>;

/** Errors with a stable code; `permanent` ones are not retried (spec §13). */
export class PipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly permanent = false,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

/**
 * Wrap a BullMQ processor so every attempt is mirrored into the
 * `ProcessingJob` collection (status, attempts, progress, structured error)
 * for the Job Monitor. Business logic stays in `handler`.
 */
export function tracked<T extends TrackedJobData, R>(
  queueName: QueueName,
  workerId: string,
  baseLogger: Logger,
  handler: TrackedHandler<T, R>,
) {
  const jobType = jobTypeForQueue(queueName);

  return async (job: Job<T>, token?: string): Promise<R> => {
    const key = `${queueName}__${job.id}`;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const logger = baseLogger.child({ jobId: job.id, queue: queueName, attempt });

    await ProcessingJobModel.updateOne(
      { idempotencyKey: key },
      {
        $set: { status: JobStatus.RUNNING, attempts: attempt, maxAttempts, workerId, startedAt: new Date(), lastError: null, errorCode: null },
        $setOnInsert: {
          idempotencyKey: key,
          jobType,
          queueName,
          bullJobId: job.id ?? null,
          entityType: job.data?.entityType ?? null,
          entityId: job.data?.entityId ?? null,
        },
      },
      { upsert: true },
    );

    const reportProgress = async (percent: number) => {
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      await Promise.all([job.updateProgress(p), ProcessingJobModel.updateOne({ idempotencyKey: key }, { $set: { progress: p } })]);
    };

    const defer = async (until: Date, reason: string): Promise<never> => {
      await ProcessingJobModel.updateOne({ idempotencyKey: key }, { $set: { status: JobStatus.PENDING, lastError: `Deferred until ${until.toISOString()}: ${reason}`.slice(0, 2000) } });
      logger.info({ until: until.toISOString(), reason }, 'Job deferred');
      await job.moveToDelayed(until.getTime(), token);
      throw new DelayedError(reason);
    };

    try {
      const result = await handler(job.data, { job, logger, reportProgress, defer });
      await ProcessingJobModel.updateOne(
        { idempotencyKey: key },
        { $set: { status: JobStatus.COMPLETED, progress: 100, completedAt: new Date(), result: result ?? null } },
      );
      logger.info('Job completed');
      return result;
    } catch (err) {
      if (err instanceof DelayedError) throw err; // not a failure: BullMQ re-runs it later
      const e = err as Error;
      const permanent = err instanceof PipelineError ? err.permanent : err instanceof UnrecoverableError;
      const willRetry = !permanent && attempt < maxAttempts;
      await ProcessingJobModel.updateOne(
        { idempotencyKey: key },
        {
          $set: {
            status: willRetry ? JobStatus.RETRYING : JobStatus.FAILED,
            lastError: e.message.slice(0, 2000),
            errorCode: err instanceof PipelineError ? err.code : 'UNEXPECTED',
            ...(willRetry ? {} : { completedAt: new Date() }),
          },
        },
      );
      logger.error({ err: e, willRetry }, 'Job failed');
      // Convert permanent failures so BullMQ stops retrying them.
      if (permanent && !(err instanceof UnrecoverableError)) throw new UnrecoverableError(e.message);
      throw err;
    }
  };
}
