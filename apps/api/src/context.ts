import type { AppConfig } from '@shorts/config';
import type { InstagramGraphClient, MetadataGenerator, YouTubeIntegration } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import type { QueueRegistry, Redis } from '@shorts/queue';

/** Dependencies injected into the Express app (makes it testable). */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  redis: Redis;
  queues: QueueRegistry;
  youtube: YouTubeIntegration;
  /** Override the configured LLM metadata writer (tests inject a deterministic one). */
  metadata?: MetadataGenerator;
  /** Override the Instagram Graph client (tests inject a fake). */
  instagram?: InstagramGraphClient;
}
