import { parseConfig } from '@shorts/config';
import { UserModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { createLogger } from '@shorts/observability';
import { MockYouTubeProvider, createMemoryQuotaTracker, type YouTubeMetadataProvider } from '@shorts/integrations';
import { QueueRegistry, createRedisConnection } from '@shorts/queue';
import { UserRole } from '@shorts/shared-types';
import { createApp } from '../src/app';
import { hashPassword } from '../src/services/auth.service';

/**
 * Integration tests run against the docker-compose MongoDB/Redis
 * (`npm run infra:up`) using an isolated database and Redis DB index.
 */
const MONGO_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/ai_shorts_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export const ADMIN = { email: 'admin@example.test', password: 'correct-horse-battery' };
export const VIEWER = { email: 'viewer@example.test', password: 'viewer-password-123' };

/** Defaults to the Mongo-backed mock provider, which also enables /dev/mock-youtube routes. */
export async function setupTestApp(provider: YouTubeMetadataProvider = new MockYouTubeProvider()) {
  const config = parseConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: MONGO_URI,
    REDIS_URL,
    JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  });
  const logger = createLogger({ service: 'api-test', level: 'silent' });
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();

  const redis = createRedisConnection(REDIS_URL);
  const queues = new QueueRegistry(redis);
  const quota = createMemoryQuotaTracker();
  const app = createApp({ config, logger, redis, queues, youtube: { provider, quota } });

  await UserModel.create([
    { email: ADMIN.email, name: 'Admin', role: UserRole.ADMIN, passwordHash: await hashPassword(ADMIN.password) },
    { email: VIEWER.email, name: 'Viewer', role: UserRole.VIEWER, passwordHash: await hashPassword(VIEWER.password) },
  ]);

  return {
    app,
    config,
    queues,
    async teardown() {
      await queues.closeAll();
      redis.disconnect();
      await mongoose.connection.dropDatabase();
      await disconnectDatabase();
    },
  };
}
