import { JobType } from './enums';

/** BullMQ queue names (spec §13). One queue per pipeline stage. */
export const QUEUE_NAMES = {
  [JobType.CHANNEL_MONITOR]: 'channel-monitor',
  [JobType.SESSION_WATCH]: 'session-watch',
  [JobType.MEDIA_ACQUISITION]: 'media-acquisition',
  [JobType.TRANSCRIPTION]: 'transcription',
  [JobType.HIGHLIGHT_ANALYSIS]: 'highlight-analysis',
  [JobType.CLIP_RENDER]: 'clip-render',
  [JobType.METADATA_GENERATION]: 'metadata-generation',
  [JobType.YOUTUBE_UPLOAD]: 'youtube-upload',
  [JobType.INSTAGRAM_UPLOAD]: 'instagram-upload',
  [JobType.CLEANUP]: 'cleanup',
} as const satisfies Record<JobType, string>;

export type QueueName = (typeof QUEUE_NAMES)[JobType];

export const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES) as QueueName[];

export const jobTypeForQueue = (queue: QueueName): JobType =>
  (Object.keys(QUEUE_NAMES) as JobType[]).find((k) => QUEUE_NAMES[k] === queue)!;
