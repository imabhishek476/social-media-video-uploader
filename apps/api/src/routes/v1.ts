import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { UserRole, loginSchema, settingsUpdateSchema, type HealthDTO } from '@shorts/shared-types';
import type { AppDeps } from '../context';
import { AppError, ErrorCode, parseOrThrow } from '../errors';
import { requireAuth, requireRole } from '../middleware/auth';
import { recordAudit } from '../services/audit.service';
import { AuthService, SESSION_COOKIE } from '../services/auth.service';
import { getDashboardSummary } from '../services/dashboard.service';
import { getJob, jobListQuerySchema, listJobs } from '../services/jobs.service';
import { CandidateService, ChannelService, ClipService, PublishService, YouTubeAccountService, LiveSessionService, SettingsService } from '@shorts/core';
import { MockYouTubeProvider, YouTubeOAuthClient, createMetadataGenerator, createObjectStorage } from '@shorts/integrations';
import { createPublishRoutes, createYouTubeCallbackRoute, createYouTubeRoutes } from './youtube';
import { createClipRoutes, createHighlightRoutes, createSessionAnalysisRoutes } from './highlights';
import { getReadiness, getSystemStatus } from '../services/system.service';
import { createMockYouTubeRoutes } from './dev';
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
    uploaderName: yt.uploadProvider,
    logger: deps.logger,
  });
  const publish = new PublishService({ settings, queues: deps.queues, account, metadata: createMetadataGenerator(deps.config), logger: deps.logger });
  const clipService = new ClipService(storage);
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

  router.use('/streamers', createStreamerRoutes(channels, adminOnly));
  router.use('/live-sessions', createSessionAnalysisRoutes(sessions, candidates, storage));
  router.use('/highlights', createHighlightRoutes(candidates, adminOnly));
  const clipRoutes = createClipRoutes(clipService, storage, deps.queues, sessions, adminOnly);
  router.use('/live-sessions', clipRoutes.sessionRouter);
  router.use('/clips', clipRoutes.clipRouter);
  router.use('/clips', createPublishRoutes(publish, clipService, adminOnly));
  router.use('/integrations/youtube', createYouTubeRoutes(account, adminOnly));
  router.use('/live-sessions', createSessionRoutes(sessions, settings, deps.config.worker.storageDir, adminOnly));
  if (deps.youtube.provider instanceof MockYouTubeProvider) {
    router.use('/dev/mock-youtube', adminOnly, createMockYouTubeRoutes(deps.youtube.provider));
  }

  router.get('/settings', async (_req, res) => {
    res.json(await settings.get());
  });

  router.patch('/settings', adminOnly, async (req, res) => {
    const patch = parseOrThrow(settingsUpdateSchema, req.body);
    const updated = await settings.update(patch, req.user!.id);
    await recordAudit(req, { action: 'settings.update', entityType: 'AppSettings', metadata: { sections: Object.keys(patch) } });
    res.json(updated);
  });

  return router;
}
