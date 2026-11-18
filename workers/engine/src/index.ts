import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig, type AppConfig } from '@shorts/config';
import { connectDatabase, disconnectDatabase } from '@shorts/database';
import { createLogger, type Logger } from '@shorts/observability';
import { QueueRegistry, Worker, clearHeartbeat, createRedisConnection, publishHeartbeat, type Redis } from '@shorts/queue';
import { LiveMonitorService, LiveSessionService, SettingsService } from '@shorts/core';
import { createYouTubeIntegration, type YouTubeIntegration } from '@shorts/integrations';
import { JobType, QUEUE_NAMES, type QueueName, type WorkerHeartbeatDTO } from '@shorts/shared-types';
import { cleanupProcessor, type CleanupJobData } from './processors/cleanup';
import { tracked } from './tracked-job';

/**
 * One deployable worker process that runs a configurable set of roles
 * (WORKER_ROLES). Start with `all`; later split heavy roles (render,
 * transcription) into their own containers without code changes (spec §18, §23).
 *
 * Roles so far: `monitor` (detect live starts), `session` (detect stream
 * ends), `cleanup` (temp files). Later phases add acquisition,
 * transcription, highlight, render and upload.
 */
interface RoleDefinition {
  queue: QueueName;
  start: (ctx: RoleContext) => Promise<void> | void;
}

interface RoleContext {
  config: AppConfig;
  logger: Logger;
  connection: Redis;
  queues: QueueRegistry;
  workerId: string;
  workers: Worker[];
  services: Services;
}

interface Services {
  settings: SettingsService;
  youtube: YouTubeIntegration;
  sessions: LiveSessionService;
  monitor: LiveMonitorService;
}

/** Scheduler "tick" jobs: frequent, cheap, never retried (the next tick is the retry). */
const TICK_JOB_OPTS = { attempts: 1, removeOnComplete: 100, removeOnFail: 500 };
const MONITOR_TICK_MS = 15_000;
const SESSION_TICK_MS = 30_000;

const ROLES: Record<string, RoleDefinition> = {
  monitor: {
    queue: QUEUE_NAMES[JobType.CHANNEL_MONITOR],
    async start({ logger, connection, queues, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.CHANNEL_MONITOR];
      workers.push(new Worker(queueName, () => services.monitor.tick(), { connection, concurrency: 1 }));
      // Each channel keeps its own nextCheckAt (Settings → polling interval); the
      // tick only decides how quickly due channels are picked up.
      await queues.get(queueName).upsertJobScheduler('channel-monitor-tick', { every: MONITOR_TICK_MS }, { name: 'tick', opts: TICK_JOB_OPTS });
      logger.info({ queue: queueName, provider: services.youtube.provider.name }, 'Monitor role started');
    },
  },
  session: {
    queue: QUEUE_NAMES[JobType.SESSION_WATCH],
    async start({ logger, connection, queues, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.SESSION_WATCH];
      workers.push(new Worker(queueName, () => services.sessions.watchTick(), { connection, concurrency: 1 }));
      await queues.get(queueName).upsertJobScheduler('session-watch-tick', { every: SESSION_TICK_MS }, { name: 'tick', opts: TICK_JOB_OPTS });
      logger.info({ queue: queueName }, 'Session watch role started');
    },
  },
  cleanup: {
    queue: QUEUE_NAMES[JobType.CLEANUP],
    async start({ config, logger, connection, queues, workerId, workers }) {
      const queueName = QUEUE_NAMES[JobType.CLEANUP];
      const tempDir = path.resolve(config.worker.storageDir, 'tmp');
      await fs.mkdir(tempDir, { recursive: true });

      workers.push(
        new Worker(queueName, tracked<CleanupJobData, unknown>(queueName, workerId, logger, cleanupProcessor), {
          connection,
          concurrency: 1,
        }),
      );

      // Idempotent: upserting the scheduler never creates duplicates across restarts or replicas.
      await queues.get(queueName).upsertJobScheduler(
        'temp-file-cleanup',
        { every: 60 * 60 * 1000 },
        { name: 'temp-file-cleanup', data: { tempDir, maxAgeHours: config.worker.tempFileMaxAgeHours } satisfies CleanupJobData },
      );
      logger.info({ queue: queueName, tempDir }, 'Cleanup role started (hourly schedule)');
    },
  },
};

async function main() {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }

  const workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const logger = createLogger({ service: 'worker', level: config.logLevel, pretty: config.env === 'development' }).child({ workerId });

  const requested = config.worker.roles.includes('all') ? Object.keys(ROLES) : config.worker.roles;
  const unknown = requested.filter((r) => !ROLES[r]);
  if (unknown.length) logger.warn({ unknown, available: Object.keys(ROLES) }, 'Ignoring unknown worker roles');
  const roles = requested.filter((r) => ROLES[r]);

  await connectDatabase(config.mongoUri, logger);
  const connection = createRedisConnection(config.redisUrl);
  connection.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));
  const queues = new QueueRegistry(connection);
  const workers: Worker[] = [];

  const settings = new SettingsService(config);
  const youtube = createYouTubeIntegration(config, connection);
  const sessions = new LiveSessionService({ queues, settings, provider: youtube.provider, logger: logger.child({ role: 'session' }) });
  const monitor = new LiveMonitorService({
    provider: youtube.provider,
    quota: youtube.quota,
    settings,
    sessions,
    dailyQuota: config.integrations.youtube.dailyQuota,
    logger: logger.child({ role: 'monitor' }),
  });
  const services: Services = { settings, youtube, sessions, monitor };

  for (const role of roles) {
    await ROLES[role]!.start({ config, logger: logger.child({ role }), connection, queues, workerId, workers, services });
  }
  for (const w of workers) w.on('error', (err) => logger.error({ err }, 'Worker error'));

  const startedAt = new Date().toISOString();
  const heartbeat: Omit<WorkerHeartbeatDTO, 'lastHeartbeatAt'> = {
    id: workerId,
    hostname: os.hostname(),
    pid: process.pid,
    roles,
    queues: roles.map((r) => ROLES[r]!.queue),
    version: process.env.npm_package_version ?? '0.1.0',
    startedAt,
  };
  const beat = () =>
    publishHeartbeat(connection, { ...heartbeat, lastHeartbeatAt: new Date().toISOString() }, config.worker.heartbeatSeconds * 3).catch(
      (err) => logger.warn({ err: err.message }, 'Heartbeat failed'),
    );
  await beat();
  const heartbeatTimer = setInterval(beat, config.worker.heartbeatSeconds * 1000);
  logger.info({ roles }, 'Worker started');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Worker shutting down (waiting for active jobs)');
    const force = setTimeout(() => process.exit(1), 30_000).unref();
    clearInterval(heartbeatTimer);
    await Promise.all(workers.map((w) => w.close()));
    await clearHeartbeat(connection, workerId).catch(() => undefined);
    await queues.closeAll().catch(() => undefined);
    connection.disconnect();
    await disconnectDatabase().catch(() => undefined);
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
