/**
 * Provider-neutral contract for YouTube channel/broadcast metadata (spec §9
 * "provider interfaces"). The pipeline only ever talks to this interface.
 */

export type ChannelRef =
  | { kind: 'id'; value: string }
  | { kind: 'handle'; value: string } // always stored with leading "@"
  | { kind: 'username'; value: string } // legacy /user/NAME
  | { kind: 'custom'; value: string } // legacy /c/NAME
  | { kind: 'video'; value: string }; // a video / live URL from the channel

export interface ResolvedChannel {
  channelId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
}

export type BroadcastContent = 'live' | 'upcoming' | 'none';

export interface VideoDetails {
  videoId: string;
  channelId: string;
  title: string;
  /** `live` while broadcasting; `none` for VODs and finished streams. */
  liveBroadcastContent: BroadcastContent;
  /** Present only for (former) live streams. */
  actualStartTime: Date | null;
  actualEndTime: Date | null;
  scheduledStartTime: Date | null;
}

export interface YouTubeMetadataProvider {
  readonly name: 'youtube' | 'mock';
  resolveChannel(ref: ChannelRef): Promise<ResolvedChannel | null>;
  /** Recent/possibly-live video IDs for a channel (cheap discovery step). */
  listCandidateVideoIds(channelId: string): Promise<string[]>;
  /**
   * Details for many videos (batched internally). Videos that are deleted or
   * private are simply absent from the result.
   */
  getVideos(videoIds: string[]): Promise<VideoDetails[]>;
}

export type ProviderErrorCode = 'QUOTA_EXCEEDED' | 'RATE_LIMITED' | 'NOT_FOUND' | 'NETWORK' | 'BAD_RESPONSE' | 'CONFIG' | 'PAUSED';

/** Structured provider failure. `retryable` drives backoff vs. surfacing. */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
