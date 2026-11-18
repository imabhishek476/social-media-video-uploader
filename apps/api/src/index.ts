import type { Server } from 'node:http';
import { ConfigError, loadConfig } from '@shorts/config';
import { connectDatabase, disconnectDatabase } from '@shorts/database';
import { createLogger } from '@shorts/observability';
import { QueueRegistry, createRedisConnection } from '@shorts/queue';
import { createApp } from './app';
import { ensureBootstrapAdmin } from './services/auth.service';
import { SettingsService } from '@shorts/core';
import { createYouTubeIntegration } from '@shorts/integrations';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }

  const logger = createLogger({ service: 'api', level: config.logLevel, pretty: config.env === 'development' });
  if (config.auth.usingDevSecret) logger.warn('JWT_SECRET not set — using an insecure development secret');

  await connectDatabase(config.mongoUri, logger);
  const redis = createRedisConnection(config.redisUrl);
  redis.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));
  const queues = new QueueRegistry(redis);
  const youtube = createYouTubeIntegration(config, redis);
  logger.info({ provider: youtube.provider.name, liveDetection: config.integrations.youtube.liveDetection }, 'YouTube metadata provider');

  await ensureBootstrapAdmin(config, logger);
  await new SettingsService(config).getValues(); // seed defaults on first boot

  const app = createApp({ config, logger, redis, queues, youtube });
  const server: Server = app.listen(config.port, () => logger.info({ port: config.port }, 'API listening'));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down API');
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    server.close();
    await queues.closeAll().catch(() => undefined);
    redis.disconnect();
    await disconnectDatabase().catch(() => undefined);
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('API failed to start:', err);
  process.exit(1);
});
