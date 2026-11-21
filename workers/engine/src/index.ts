import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig, type AppConfig } from '@shorts/config';
import { connectDatabase, disconnectDatabase } from '@shorts/database';
import { createLogger, type Logger } from '@shorts/observability';
import { DelayedError, QueueRegistry, UnrecoverableError, Worker, clearHeartbeat, createRedisConnection, publishHeartbeat, type Redis } from '@shorts/queue';
import {
  AcquisitionService,
  AnalysisService,
  LiveMonitorService,
  ChatSampler,
  InstagramAccountService,
  InstagramPublishService,
  LiveSessionService,
  NotificationService,
  PublishService,
  budgetStatus,
  recoverStuckSessions,
  refreshVideoStats,
  sweepClipFiles,
  sweepDoneSources,
  sweepTranscripts,
  RenderService,
  UploadService,
  YouTubeAccountService,
  enqueueMetadata,
  SettingsService,
  createVideoSourceProvider,
  InboxWatcher,
  SessionImportService,
  enqueueHighlightAnalysis,
  enqueueRender,
  enqueueTranscription,
  incomingDir,
  sweepExpiredSources,
} from '@shorts/core';
import { GeneratedClipModel, LiveSessionModel, StreamerChannelModel } from '@shorts/database';
import {
  GoogleYouTubeUploader,
  LogNotifier,
  TelegramNotifier,
  YouTubeOAuthClient,
  createFacecamDetector,
  createHighlightAnalyzer,
  createMetadataGenerator,
  createObjectStorage,
  createTranscriptionProvider,
  createYouTubeIntegration,
  InstagramGraphClient,
  type ObjectStorage,
  type YouTubeIntegration,
} from '@shorts/integrations';
import { JobType, QUEUE_NAMES, type QueueName, type WorkerHeartbeatDTO } from '@shorts/shared-types';
import { cleanupProcessor, type CleanupJobData } from './processors/cleanup';
import { PipelineError, tracked, type JobContext, type TrackedJobData } from './tracked-job';

/**
 * One deployable worker process that runs a configurable set of roles
 * (WORKER_ROLES). Start with `all`; later split heavy roles (render,
 * transcription) into their own containers without code changes (spec §18, §23).
 *
 * Roles: `monitor` (detect live starts), `session` (detect stream ends),
 * `acquisition` (store the recording), `transcription`, `highlight`
 * (AI analysis), `render` (vertical Shorts), `metadata`, `upload` and `cleanup`.
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
  chat: ChatSampler;
  instagram: InstagramPublishService;
  instagramAccount: InstagramAccountService;
  acquisition: AcquisitionService;
  analysis: AnalysisService;
  render: RenderService;
  publish: PublishService;
  upload: UploadService;
  account: YouTubeAccountService;
  notify: NotificationService;
  inbox: InboxWatcher;
  storage: ObjectStorage;
}

type SessionJobData = TrackedJobData & { liveSessionId?: string; round?: number };

/** Current reprocess round of a session (part of each stage's idempotency key). */
async function currentRound(sessionId: string): Promise<number> {
  const s = await LiveSessionModel.findById(sessionId).select('reprocessCount').lean();
  return s?.reprocessCount ?? 0;
}

/** Run a session pipeline step; when it fails for the last time, record that on the session. */
function sessionStep<R>(services: Services, step: (sessionId: string, data: SessionJobData, ctx: JobContext) => Promise<R>) {
  return async (data: SessionJobData, ctx: JobContext): Promise<R> => {
    if (!data.liveSessionId) throw new PipelineError('BAD_PAYLOAD', 'Missing liveSessionId', true);
    try {
      return await step(data.liveSessionId, data, ctx);
    } catch (err) {
      if (err instanceof DelayedError) throw err; // deferred, not failed
      const final = err instanceof UnrecoverableError || (err instanceof PipelineError && err.permanent) || ctx.job.attemptsMade + 1 >= (ctx.job.opts.attempts ?? 1);
      if (final) {
        const msg = `${ctx.job.name} failed: ${(err as Error).message}`;
        await services.analysis.markFailed(data.liveSessionId, msg).catch(() => undefined);
        await services.notify.processingFailed(data.liveSessionId, msg);
      }
      throw err;
    }
  };
}

/**
 * Cost control: paid AI steps wait while the monthly budget is used up.
 * Re-checked every 6 h, so raising the budget resumes work without a restart.
 */
async function budgetGate(services: Services, sessionId: string, ctx: JobContext): Promise<void> {
  const b = await budgetStatus(services.settings);
  if (!b.exceeded || !b.resumesAt) return;
  const spent = `$${b.spentUsd.toFixed(2)} of $${b.budgetUsd.toFixed(2)}`;
  await LiveSessionModel.updateOne(
    { _id: sessionId },
    { $set: { lastError: `Paused: monthly AI budget reached (${spent}). Raise it in Settings → Costs, or it resumes next month.` } },
  );
  await services.notify.budgetReached(b.spentUsd, b.budgetUsd);
  await ctx.defer(new Date(Math.min(b.resumesAt.getTime(), Date.now() + 6 * 3600_000)), 'Monthly AI budget reached');
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
  acquisition: {
    queue: QUEUE_NAMES[JobType.MEDIA_ACQUISITION],
    async start({ config, logger, connection, queues, workerId, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.MEDIA_ACQUISITION];
      await fs.mkdir(incomingDir(config.worker.storageDir), { recursive: true });
      workers.push(
        new Worker(
          queueName,
          tracked<SessionJobData, string>(queueName, workerId, logger, async (data, ctx) => {
            if (ctx.job.name === 'inbox-pickup') return JSON.stringify(await services.inbox.tick());
            if (!data.liveSessionId) throw new PipelineError('BAD_PAYLOAD', 'Missing liveSessionId', true);
            const outcome = await services.acquisition.acquire(data.liveSessionId, ctx.reportProgress);
            if (outcome === 'READY' || outcome === 'ALREADY_READY') {
              await enqueueTranscription(queues, data.liveSessionId, await currentRound(data.liveSessionId));
            }
            return outcome;
          }),
          { connection, concurrency: config.defaults.maxConcurrentTranscodeJobs, lockDuration: 10 * 60 * 1000 },
        ),
      );
      // Recordings dropped into the inbox start processing within ~2 minutes.
      await queues.get(queueName).upsertJobScheduler('inbox-pickup', { every: 2 * 60 * 1000 }, { name: 'inbox-pickup', data: {}, opts: TICK_JOB_OPTS });
      logger.info({ queue: queueName, storage: services.storage.name }, 'Acquisition role started');
    },
  },
  transcription: {
    queue: QUEUE_NAMES[JobType.TRANSCRIPTION],
    async start({ config, logger, connection, queues, workerId, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.TRANSCRIPTION];
      workers.push(
        new Worker(
          queueName,
          tracked<SessionJobData, string>(
            queueName,
            workerId,
            logger,
            sessionStep(services, async (sessionId, data, ctx) => {
              await budgetGate(services, sessionId, ctx);
              const outcome = await services.analysis.transcribe(sessionId, ctx.reportProgress, ctx.defer);
              if (outcome !== 'SKIPPED') await enqueueHighlightAnalysis(queues, sessionId, data.round ?? (await currentRound(sessionId)));
              return outcome;
            }),
          ),
          // Long streams take a while to download and transcribe.
          { connection, concurrency: config.defaults.maxConcurrentTranscodeJobs, lockDuration: 30 * 60 * 1000 },
        ),
      );
      logger.info({ queue: queueName, provider: config.integrations.transcription.provider }, 'Transcription role started');
    },
  },
  highlight: {
    queue: QUEUE_NAMES[JobType.HIGHLIGHT_ANALYSIS],
    async start({ config, logger, connection, queues, workerId, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.HIGHLIGHT_ANALYSIS];
      workers.push(
        new Worker(
          queueName,
          tracked<SessionJobData, unknown>(
            queueName,
            workerId,
            logger,
            sessionStep(services, async (sessionId, data, ctx) => {
              await budgetGate(services, sessionId, ctx);
              const result = await services.analysis.analyze(sessionId, data.round ?? 0, ctx.reportProgress);
              if (result !== 'SKIPPED' && result.selected > 0) await enqueueRender(queues, sessionId, `round-${data.round ?? 0}`);
              return result;
            }),
          ),
          { connection, concurrency: 2, lockDuration: 15 * 60 * 1000 },
        ),
      );
      logger.info({ queue: queueName, provider: config.integrations.llm.provider, model: config.integrations.llm.model }, 'Highlight analysis role started');
    },
  },
  render: {
    queue: QUEUE_NAMES[JobType.CLIP_RENDER],
    async start({ config, logger, connection, queues, workerId, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.CLIP_RENDER];
      workers.push(
        new Worker(
          queueName,
          // Render failures are recorded per clip; only job-level failures (e.g. source gone) fail the session step.
          tracked<SessionJobData, unknown>(queueName, workerId, logger, async (data, ctx) => {
            if (!data.liveSessionId) throw new PipelineError('BAD_PAYLOAD', 'Missing liveSessionId', true);
            const result = await services.render.renderSession(data.liveSessionId, ctx.reportProgress, { force: Boolean((data as { force?: boolean }).force) });
            if (result !== 'SKIPPED' && result.rendered > 0) await enqueueMetadata(queues, data.liveSessionId, `render-${ctx.job.id}`);
            return result;
          }),
          { connection, concurrency: config.defaults.maxConcurrentTranscodeJobs, lockDuration: 30 * 60 * 1000 },
        ),
      );
      logger.info({ queue: queueName }, 'Render role started');
    },
  },
  metadata: {
    queue: QUEUE_NAMES[JobType.METADATA_GENERATION],
    async start({ config, logger, connection, workerId, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.METADATA_GENERATION];
      workers.push(
        new Worker(
          queueName,
          tracked<SessionJobData, unknown>(queueName, workerId, logger, async (data, ctx) => {
            if (!data.liveSessionId) throw new PipelineError('BAD_PAYLOAD', 'Missing liveSessionId', true);
            await budgetGate(services, data.liveSessionId, ctx);
            const result = await services.publish.prepareSession(data.liveSessionId);
            // Manual mode: tell the operator there is something to review.
            const waiting = await GeneratedClipModel.countDocuments({ liveSessionId: data.liveSessionId, renderStatus: 'RENDERED', approvalStatus: 'PENDING', title: { $ne: '' } });
            if (result.generated > 0 && waiting > 0) {
              const s = await LiveSessionModel.findById(data.liveSessionId).select('streamerChannelId').lean();
              const ch = s ? await StreamerChannelModel.findById(s.streamerChannelId).select('displayName').lean() : null;
              await services.notify.reviewReady(data.liveSessionId, ch?.displayName ?? 'a streamer', waiting);
            }
            return result;
          }),
          { connection, concurrency: 2 },
        ),
      );
      logger.info({ queue: queueName, provider: config.integrations.llm.provider }, 'Metadata role started');
    },
  },
  upload: {
    queue: QUEUE_NAMES[JobType.YOUTUBE_UPLOAD],
    async start({ config, logger, connection, workerId, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.YOUTUBE_UPLOAD];
      workers.push(
        new Worker(
          queueName,
          tracked<TrackedJobData & { clipId?: string }, unknown>(queueName, workerId, logger, async (data, ctx) => {
            if (!data.clipId) throw new PipelineError('BAD_PAYLOAD', 'Missing clipId', true);
            try {
              const res = await services.upload.upload(data.clipId, { defer: ctx.defer, onProgress: ctx.reportProgress });
              if (res !== 'SKIPPED') {
                const c = await GeneratedClipModel.findById(data.clipId).select('title').lean();
                const { publishing } = (await services.settings.getValues()).values;
                await services.notify.published(c?.title ?? 'Short', res.url, publishing.privacyStatus);
              }
              return res;
            } catch (err) {
              if (err instanceof DelayedError) throw err;
              const final = err instanceof UnrecoverableError || ctx.job.attemptsMade + 1 >= (ctx.job.opts.attempts ?? 1);
              if (final) {
                const msg = (err as Error).message;
                await services.upload.markFailed(data.clipId, msg).catch(() => undefined);
                const c = await GeneratedClipModel.findById(data.clipId).select('title').lean();
                if (/reconnect/i.test(msg)) await services.notify.youtubeReconnect(msg);
                else await services.notify.uploadFailed(c?.title ?? 'Short', msg);
              }
              throw err;
            }
          }),
          // One upload at a time keeps the daily limit and spacing exact.
          { connection, concurrency: 1, lockDuration: 30 * 60 * 1000 },
        ),
      );
      logger.info({ queue: queueName }, 'Upload role started');
    },
  },
  instagram: {
    queue: QUEUE_NAMES[JobType.INSTAGRAM_UPLOAD],
    async start({ logger, connection, queues, workerId, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.INSTAGRAM_UPLOAD];
      workers.push(
        new Worker(
          queueName,
          async (job, token) => {
            // Daily: keep the 60-day Instagram token alive.
            if (job.name === 'refresh-token') return services.instagramAccount.refreshIfNeeded();
            return tracked<TrackedJobData & { clipId?: string }, unknown>(queueName, workerId, logger, async (data, ctx) => {
              if (!data.clipId) throw new PipelineError('BAD_PAYLOAD', 'Missing clipId', true);
              try {
                const res = await services.instagram.post(data.clipId, { defer: ctx.defer, onProgress: ctx.reportProgress });
                if (res !== 'SKIPPED' && res.permalink) {
                  const c = await GeneratedClipModel.findById(data.clipId).select('title').lean();
                  await services.notify.published(c?.title ?? 'Reel', res.permalink, 'Instagram');
                }
                return res;
              } catch (err) {
                if (err instanceof DelayedError) throw err;
                const final = err instanceof UnrecoverableError || ctx.job.attemptsMade + 1 >= (ctx.job.opts.attempts ?? 1);
                if (final) await services.instagram.markFailed(data.clipId, (err as Error).message).catch(() => undefined);
                throw err;
              }
            })(job, token);
          },
          { connection, concurrency: 1, lockDuration: 30 * 60 * 1000 },
        ),
      );
      await queues.get(queueName).upsertJobScheduler('instagram-token-refresh', { every: 24 * 60 * 60 * 1000 }, { name: 'refresh-token', data: {}, opts: TICK_JOB_OPTS });
      logger.info({ queue: queueName }, 'Instagram role started');
    },
  },
  session: {
    queue: QUEUE_NAMES[JobType.SESSION_WATCH],
    async start({ logger, connection, queues, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.SESSION_WATCH];
      workers.push(new Worker(queueName, (job) => (job.name === 'chat-tick' ? services.chat.tick() : services.sessions.watchTick()), { connection, concurrency: 1 }));
      await queues.get(queueName).upsertJobScheduler('session-watch-tick', { every: SESSION_TICK_MS }, { name: 'tick', opts: TICK_JOB_OPTS });
      await queues.get(queueName).upsertJobScheduler('chat-sample-tick', { every: SESSION_TICK_MS }, { name: 'chat-tick', opts: TICK_JOB_OPTS });
      logger.info({ queue: queueName }, 'Session watch role started');
    },
  },
  cleanup: {
    queue: QUEUE_NAMES[JobType.CLEANUP],
    async start({ config, logger, connection, queues, workerId, workers, services }) {
      const queueName = QUEUE_NAMES[JobType.CLEANUP];
      const tempDir = path.resolve(config.worker.storageDir, 'tmp');
      await fs.mkdir(tempDir, { recursive: true });

      workers.push(
        new Worker(queueName, tracked<CleanupJobData, unknown>(queueName, workerId, logger, async (data, ctx) => {
            const deps = { settings: services.settings, storage: services.storage, logger };
            switch (ctx.job.name) {
              case 'sweep-sources':
                // Retention: old recordings, recordings of finished streams, expired clip files, old transcripts.
                return {
                  expired: await sweepExpiredSources(deps),
                  finished: await sweepDoneSources(deps),
                  clips: await sweepClipFiles(deps),
                  transcripts: await sweepTranscripts(deps),
                };
              case 'watchdog': {
                const failed = await recoverStuckSessions({ logger });
                for (const id of failed) await services.notify.processingFailed(id, 'Processing stalled; press Reprocess.');
                return { failed: failed.length };
              }
              case 'refresh-stats':
                try {
                  return await refreshVideoStats({ account: services.account, logger });
                } catch (err) {
                  if (/reconnect/i.test((err as Error).message)) await services.notify.youtubeReconnect((err as Error).message);
                  throw err;
                }
              default:
                return cleanupProcessor(data, ctx);
            }
          }), {
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
      await queues.get(queueName).upsertJobScheduler('expired-source-sweep', { every: 60 * 60 * 1000 }, { name: 'sweep-sources', data: {} });
      await queues.get(queueName).upsertJobScheduler('stuck-session-watchdog', { every: 15 * 60 * 1000 }, { name: 'watchdog', data: {}, opts: TICK_JOB_OPTS });
      await queues.get(queueName).upsertJobScheduler('youtube-stats', { every: 6 * 60 * 60 * 1000 }, { name: 'refresh-stats', data: {}, opts: TICK_JOB_OPTS });
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
  const chat = new ChatSampler({
    chat: youtube.chat!,
    quota: youtube.quota,
    settings,
    dailyQuota: config.integrations.youtube.dailyQuota,
    logger: logger.child({ role: 'chat' }),
  });
  const storage = createObjectStorage(config);
  const acquisition = new AcquisitionService({
    settings,
    storage,
    source: createVideoSourceProvider(config.worker.storageDir, storage, config.integrations.videoSource.provider, config.integrations.videoSource.ytdlpBinary),
    tempDir: path.join(config.worker.storageDir, 'tmp'),
    logger: logger.child({ role: 'acquisition' }),
  });
  const analysis = new AnalysisService({
    settings,
    storage,
    transcription: createTranscriptionProvider(config),
    analyzer: createHighlightAnalyzer(config),
    workDir: path.join(config.worker.storageDir, 'tmp'),
    language: config.integrations.transcription.language,
    logger: logger.child({ role: 'analysis' }),
  });
  const render = new RenderService({ settings, storage, workDir: path.join(config.worker.storageDir, 'tmp'), facecam: createFacecamDetector(config), logger: logger.child({ role: 'render' }) });
  const yt = config.integrations.youtube;
  const account = new YouTubeAccountService({
    oauth: yt.clientId && yt.clientSecret ? new YouTubeOAuthClient({ clientId: yt.clientId, clientSecret: yt.clientSecret, redirectUri: yt.redirectUri }) : null,
    redis: connection,
    encryptionKey: config.encryptionKey,
    logger: logger.child({ role: 'youtube' }),
  });
  const igClient = new InstagramGraphClient();
  const instagramAccount = new InstagramAccountService({ client: igClient, encryptionKey: config.encryptionKey, logger: logger.child({ role: 'instagram' }) });
  const instagram = new InstagramPublishService({
    settings,
    storage,
    queues,
    account: instagramAccount,
    client: igClient,
    workDir: path.join(config.worker.storageDir, 'tmp'),
    logger: logger.child({ role: 'instagram' }),
  });
  const publish = new PublishService({
    settings,
    queues,
    account,
    metadata: createMetadataGenerator(config),
    logger: logger.child({ role: 'metadata' }),
    afterApprove: (id) => instagram.queueWithYouTube(id),
  });
  const upload = new UploadService({
    settings,
    storage,
    account,
    uploader: new GoogleYouTubeUploader(),
    workDir: path.join(config.worker.storageDir, 'tmp'),
    logger: logger.child({ role: 'upload' }),
  });
  const n = config.integrations.notifications;
  const notify = new NotificationService({
    notifier:
      n.telegramBotToken && n.telegramChatId
        ? new TelegramNotifier({ botToken: n.telegramBotToken, chatId: n.telegramChatId })
        : new LogNotifier((text) => logger.info({ notification: text }, 'Notification')),
    webOrigin: config.webOrigin,
    redis: connection,
    logger: logger.child({ role: 'notify' }),
  });
  const inbox = new InboxWatcher({
    storage,
    storageDir: config.worker.storageDir,
    sessions,
    importer: new SessionImportService({ provider: youtube.provider, sessions, logger: logger.child({ role: 'inbox' }) }),
    logger: logger.child({ role: 'inbox' }),
  });
  const services: Services = { settings, youtube, sessions, monitor, chat, instagram, instagramAccount, acquisition, analysis, render, publish, upload, account, notify, inbox, storage };

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
