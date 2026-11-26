import path from 'node:path';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { JobType, QUEUE_NAMES, UserRole, facecamUpdateSchema, instagramConnectSchema, loginSchema, sessionImportSchema, settingsUpdateSchema, type HealthDTO } from '@shorts/shared-types';
import { LiveSessionModel } from '@shorts/database';
import type { AppDeps } from '../context';
import { AppError, ErrorCode, parseOrThrow } from '../errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { recordAudit } from '../services/audit.service';
import { AuthService, SESSION_COOKIE } from '../services/auth.service';
import { getDashboardSummary } from '../services/dashboard.service';
import { getJob, jobListQuerySchema, listJobs } from '../services/jobs.service';
import { toClipDTO } from '@shorts/core';
import { ScheduleService, StreamerPurgeService } from '@shorts/core';
import { CandidateService, ChannelService, ClipService, InstagramAccountService, InstagramPublishService, PublishService, SessionImportService, YouTubeAccountService, LiveSessionService, SettingsService } from '@shorts/core';
import { GcsObjectStorage, InstagramGraphClient, YouTubeOAuthClient, createMetadataGenerator, createObjectStorage } from '@shorts/integrations';
import { createPublishRoutes, createYouTubeCallbackRoute, createYouTubeRoutes } from './youtube';
import { createScheduleRoutes } from './schedule';
import { createClipRoutes, createHighlightRoutes, createSessionAnalysisRoutes } from './highlights';
import { getReadiness, getSystemStatus } from '../services/system.service';
import { createSessionRoutes } from './sessions';
import { createStreamerRoutes } from './streamers';

const startedAt = Date.now();

/**
 * /api/v1 routes. Handlers stay thin: parse input → call a service → respond.
 * Express 5 forwards rejected promises to the error handler automatically.
 */
export function createV1Router(deps: AppDeps): Router {
  const router = Router();
  const auth = new AuthService(deps.config);
  const settings = new SettingsService(deps.config);
  const channels = new ChannelService(deps.youtube.provider);
  const sessions = new LiveSessionService({ queues: deps.queues, settings, provider: deps.youtube.provider, storageName: deps.config.integrations.storage.provider, logger: deps.logger });
  const candidates = new CandidateService(settings);
  const storage = createObjectStorage(deps.config);
  const yt = deps.config.integrations.youtube;
  const account = new YouTubeAccountService({
    oauth: yt.clientId && yt.clientSecret ? new YouTubeOAuthClient({ clientId: yt.clientId, clientSecret: yt.clientSecret, redirectUri: yt.redirectUri }) : null,
    redis: deps.redis,
    encryptionKey: deps.config.encryptionKey,
    logger: deps.logger,
  });
  const igClient = deps.instagram ?? new InstagramGraphClient();
  const igAccount = new InstagramAccountService({ client: igClient, encryptionKey: deps.config.encryptionKey, logger: deps.logger });
  const instagram = new InstagramPublishService({ settings, storage, queues: deps.queues, account: igAccount, client: igClient, workDir: deps.config.worker.storageDir, logger: deps.logger });
  const schedule = new ScheduleService({ settings, accessToken: () => account.accessToken(), logger: deps.logger });
  const publish = new PublishService({
    schedule,
    settings,
    queues: deps.queues,
    account,
    metadata: deps.metadata ?? createMetadataGenerator(deps.config),
    logger: deps.logger,
    afterApprove: (id) => instagram.queueWithYouTube(id),
  });
  const clipService = new ClipService(storage);
  // Files may sit in the current storage and, after a switch, in Cloud Storage too.
  const st = deps.config.integrations.storage;
  const purgeStorages = [storage, ...(st.provider === 'local' && st.bucket ? [new GcsObjectStorage({ bucket: st.bucket, projectId: st.projectId, keyFile: st.keyFile })] : [])];
  const purge = new StreamerPurgeService({ storages: purgeStorages, queues: deps.queues, tempDir: path.join(deps.config.worker.storageDir, 'tmp'), logger: deps.logger });

  const authenticated = requireAuth(auth);
  const adminOnly = requireRole(UserRole.ADMIN);

  const limiterHandler = () => {
    throw new AppError(429, ErrorCode.RATE_LIMITED, 'Too many requests, please try again later');
  };
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: deps.config.isProduction ? 10 : 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: limiterHandler,
  });
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: limiterHandler,
  });

  // --- Public -------------------------------------------------------------
  router.get('/health', (_req, res) => {
    const body: HealthDTO = {
      status: 'ok',
      service: 'api',
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    };
    res.json(body);
  });

  router.get('/ready', async (_req, res) => {
    const ready = await getReadiness(deps);
    res.status(ready.status === 'ready' ? 200 : 503).json(ready);
  });

  router.post('/auth/login', loginLimiter, async (req, res) => {
    const input = parseOrThrow(loginSchema, req.body);
    try {
      const user = await auth.verifyCredentials(input.email, input.password);
      res.cookie(SESSION_COOKIE, auth.issueToken(user), auth.cookieOptions());
      await recordAudit(req, { action: 'auth.login', entityType: 'User', entityId: user.id, actor: user });
      res.json({ user });
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.INVALID_CREDENTIALS) {
        await recordAudit(req, { action: 'auth.login_failed', metadata: { email: input.email } });
      }
      throw err;
    }
  });

  router.get('/integrations/youtube/callback', loginLimiter, createYouTubeCallbackRoute(account, deps.config.webOrigin, deps.logger));

  // --- Authenticated --------------------------------------------------------
  router.use(apiLimiter, authenticated);

  router.post('/auth/logout', async (req, res) => {
    await recordAudit(req, { action: 'auth.logout' });
    const { maxAge: _maxAge, ...cookieOpts } = auth.cookieOptions();
    res.clearCookie(SESSION_COOKIE, cookieOpts);
    res.status(204).end();
  });

  router.get('/auth/me', (req, res) => {
    res.json({ user: req.user });
  });

  router.get('/dashboard/summary', async (_req, res) => {
    res.json(await getDashboardSummary(settings));
  });

  router.get('/system/status', async (_req, res) => {
    res.json(await getSystemStatus(deps));
  });

  router.get('/jobs', async (req, res) => {
    res.json(await listJobs(parseOrThrow(jobListQuerySchema, req.query)));
  });

  router.get('/jobs/:id', async (req, res) => {
    res.json(await getJob(req.params.id));
  });

  router.use('/streamers', createStreamerRoutes(channels, adminOnly, purge));
  const importer = new SessionImportService({ provider: deps.youtube.provider, sessions, logger: deps.logger });
  router.post('/live-sessions/import', adminOnly, async (req, res) => {
    const { url } = parseOrThrow(sessionImportSchema, req.body);
    const result = await importer.importVideo(url);
    await recordAudit(req, { action: 'session.import', entityType: 'LiveSession', entityId: result.session.id, metadata: { url, created: result.created } });
    res.status(result.created ? 201 : 200).json(result);
  });
  /** Set the facecam box by hand (or `null` to detect again on the next render). */
  router.put('/live-sessions/:id/facecam', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    const { box } = parseOrThrow(facecamUpdateSchema, req.body);
    await sessions.get(id);
    await LiveSessionModel.updateOne({ _id: id }, { $set: { facecam: box ? { ...box, source: 'manual', detectedAt: new Date() } : null } });
    await recordAudit(req, { action: 'session.facecam', entityType: 'LiveSession', entityId: id, metadata: { box } });
    res.json(await sessions.get(id));
  });
  router.use('/live-sessions', createSessionAnalysisRoutes(sessions, candidates, storage));
  router.use('/highlights', createHighlightRoutes(candidates, adminOnly));
  const clipRoutes = createClipRoutes(clipService, storage, deps.queues, sessions, adminOnly);
  router.use('/live-sessions', clipRoutes.sessionRouter);
  router.use('/clips', clipRoutes.clipRouter);
  router.use('/clips', createPublishRoutes(publish, clipService, adminOnly));
  router.use(createScheduleRoutes(schedule, adminOnly));
  router.use('/integrations/youtube', createYouTubeRoutes(account, adminOnly));

  router.put('/integrations/instagram', adminOnly, async (req, res) => {
    const { accessToken } = parseOrThrow(instagramConnectSchema, req.body);
    const status = await igAccount.connect(accessToken, req.user!.id);
    await recordAudit(req, { action: 'instagram.connect', entityType: 'IntegrationCredential', metadata: { username: status.username } });
    res.json(status);
  });
  router.delete('/integrations/instagram', adminOnly, async (req, res) => {
    await igAccount.disconnect();
    await recordAudit(req, { action: 'instagram.disconnect', entityType: 'IntegrationCredential' });
    res.status(204).end();
  });
  /** Queue (or retry) the Instagram Reel for a rendered clip. */
  router.post('/clips/:id/instagram', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    await instagram.queue(id);
    await recordAudit(req, { action: 'clip.instagram', entityType: 'GeneratedClip', entityId: id });
    res.status(202).json(toClipDTO(await clipService.get(id)));
  });
  router.delete('/live-sessions/:id', adminOnly, async (req, res) => {
    const id = String(req.params.id);
    const summary = await purge.purgeSession(id);
    await recordAudit(req, { action: 'session.delete', entityType: 'LiveSession', entityId: id, metadata: { ...summary } });
    res.status(204).end();
  });
  router.use('/live-sessions', createSessionRoutes(sessions, settings, deps.config.worker.storageDir, adminOnly));

  router.get('/settings', async (_req, res) => {
    res.json(await settings.get());
  });

  router.patch('/settings', adminOnly, async (req, res) => {
    const patch = parseOrThrow(settingsUpdateSchema, req.body);
    const before = (await settings.getValues()).values.publishing.instagramTiming;
    const updated = await settings.update(patch, req.user!.id);
    // Switched to "post Reels straight away": release Reels already waiting for their YouTube time.
    if (before !== 'IMMEDIATE' && updated.publishing.instagramTiming === 'IMMEDIATE') {
      const queue = deps.queues.get(QUEUE_NAMES[JobType.INSTAGRAM_UPLOAD]);
      const delayed = await queue.getDelayed();
      await Promise.all(delayed.map((j) => j.promote().catch(() => undefined)));
    }
    await recordAudit(req, { action: 'settings.update', entityType: 'AppSettings', metadata: { sections: Object.keys(patch) } });
    res.json(updated);
  });

  return router;
}
