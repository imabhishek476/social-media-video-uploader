import type { AppConfig } from '@shorts/config';
import type { YouTubeIntegration } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import type { QueueRegistry, Redis } from '@shorts/queue';

/** Dependencies injected into the Express app (makes it testable). */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  redis: Redis;
  queues: QueueRegistry;
  youtube: YouTubeIntegration;
}
