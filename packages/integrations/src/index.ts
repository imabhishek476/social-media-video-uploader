import type { AppConfig } from '@shorts/config';
import type { Redis } from '@shorts/queue';
import { YouTubeDataApiProvider } from './youtube/data-api-provider';
import { createRedisQuotaTracker, type QuotaTracker } from './youtube/quota';
import type { LiveChatProvider, YouTubeMetadataProvider } from './youtube/types';

export * from './youtube/types';
export * from './youtube/parse';
export * from './youtube/quota';
export { YouTubeDataApiProvider } from './youtube/data-api-provider';
export * from './youtube/publish';
export * from './instagram';

export interface YouTubeIntegration {
  provider: YouTubeMetadataProvider;
  /** Live-chat sampling (absent in tests that don't need it). */
  chat?: LiveChatProvider;
  quota: QuotaTracker;
}

/** Build the configured metadata provider (shared by API and worker). */
export function createYouTubeIntegration(config: AppConfig, redis: Redis): YouTubeIntegration {
  const quota = createRedisQuotaTracker(redis);
  const yt = config.integrations.youtube;
  const provider = new YouTubeDataApiProvider({ apiKey: yt.apiKey!, liveDetection: yt.liveDetection, quota });
  return { provider, quota, chat: provider };
}
export * from './storage';
export * from './ai';
export * from './notify';
