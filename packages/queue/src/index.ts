import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { ALL_QUEUE_NAMES, type QueueCountsDTO, type QueueName, type WorkerHeartbeatDTO } from '@shorts/shared-types';

export { Queue, Worker, QueueEvents, UnrecoverableError, type Job, type JobsOptions, type Processor } from 'bullmq';
export { Redis } from 'ioredis';

/** BullMQ requires `maxRetriesPerRequest: null` on blocking connections. */
export function createRedisConnection(url: string, options: { lazyConnect?: boolean } = {}): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: options.lazyConnect });
}

/**
 * Default policy (spec §13): exponential backoff for transient failures and
 * bounded history. Permanent errors should throw `UnrecoverableError` so
 * they are not retried.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

/**
 * Build a stable BullMQ job id from parts. BullMQ rejects ":" in custom ids,
 * so parts are joined with "__" and sanitised.
 */
export function idempotencyKey(...parts: Array<string | number>): string {
  return parts.map((p) => String(p).replace(/[^A-Za-z0-9_.-]/g, '-')).join('__');
}

export class QueueRegistry {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly connection: Redis) {}

  get(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Enqueue with a stable job id; enqueuing the same key again while the job
   * still exists in Redis is a no-op. Durable dedupe lives in
   * `ProcessingJob.idempotencyKey` (MongoDB).
   */
  async enqueue<T extends object>(name: QueueName, jobName: string, data: T, key: string, opts: JobsOptions = {}) {
    return this.get(name).add(jobName, data, { ...opts, jobId: key });
  }

  async counts(): Promise<QueueCountsDTO[]> {
    return Promise.all(
      ALL_QUEUE_NAMES.map(async (queue) => {
        const c = await this.get(queue).getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
        return {
          queue,
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          completed: c.completed ?? 0,
          failed: c.failed ?? 0,
          paused: c.paused ?? 0,
        };
      }),
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}

// ---------------------------------------------------------------------------
// Worker heartbeats — lets the dashboard show live worker status without the
// workers exposing HTTP ports.
// ---------------------------------------------------------------------------

const HEARTBEAT_PREFIX = 'shorts:workers:heartbeat:';

export async function publishHeartbeat(redis: Redis, hb: WorkerHeartbeatDTO, ttlSeconds: number): Promise<void> {
  await redis.set(`${HEARTBEAT_PREFIX}${hb.id}`, JSON.stringify(hb), 'EX', ttlSeconds);
}

export async function clearHeartbeat(redis: Redis, workerId: string): Promise<void> {
  await redis.del(`${HEARTBEAT_PREFIX}${workerId}`);
}

export async function listHeartbeats(redis: Redis): Promise<WorkerHeartbeatDTO[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${HEARTBEAT_PREFIX}*`, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  return values
    .filter((v): v is string => v !== null)
    .map((v) => JSON.parse(v) as WorkerHeartbeatDTO)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function pingRedis(redis: Redis): Promise<number> {
  const started = Date.now();
  await redis.ping();
  return Date.now() - started;
}
