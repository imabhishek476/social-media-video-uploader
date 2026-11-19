import type { AppConfig } from '@shorts/config';
import type { Redis } from '@shorts/queue';
import { YouTubeDataApiProvider } from './youtube/data-api-provider';
import { MockYouTubeProvider } from './youtube/mock-provider';
import { createRedisQuotaTracker, type QuotaTracker } from './youtube/quota';
import type { YouTubeMetadataProvider } from './youtube/types';

export * from './youtube/types';
export * from './youtube/parse';
export * from './youtube/quota';
export { YouTubeDataApiProvider } from './youtube/data-api-provider';
export { MockYouTubeProvider, type MockEndMode } from './youtube/mock-provider';
export * from './youtube/publish';

export interface YouTubeIntegration {
  provider: YouTubeMetadataProvider;
  quota: QuotaTracker;
}

/** Build the configured metadata provider (shared by API and worker). */
export function createYouTubeIntegration(config: AppConfig, redis: Redis): YouTubeIntegration {
  const quota = createRedisQuotaTracker(redis);
  const yt = config.integrations.youtube;
  const provider =
    yt.metadataProvider === 'youtube'
      ? new YouTubeDataApiProvider({ apiKey: yt.apiKey!, liveDetection: yt.liveDetection, quota })
      : new MockYouTubeProvider();
  return { provider, quota };
}
export * from './storage';
export * from './ai';
export * from './notify';
