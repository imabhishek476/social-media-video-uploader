import type {
  ApprovalStatus,
  JobStatus,
  JobType,
  LiveStatus,
  ProcessingStatus,
  RenderStatus,
  SessionStatus,
  UploadStatus,
  UserRole,
} from './enums';
import type { AppSettingsInput } from './schemas';
import type { QueueName } from './queues';

/** API response contracts. Dates are ISO strings over the wire. */

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  lastLoginAt: string | null;
}

export interface DependencyCheck {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface HealthDTO {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  time: string;
}

export interface ReadyDTO {
  status: 'ready' | 'not_ready';
  checks: { mongo: DependencyCheck; redis: DependencyCheck };
}

export interface WorkerHeartbeatDTO {
  id: string;
  hostname: string;
  pid: number;
  roles: string[];
  queues: string[];
  version: string;
  startedAt: string;
  lastHeartbeatAt: string;
}

export interface QueueCountsDTO {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
}

export interface SystemStatusDTO {
  ready: ReadyDTO;
  workers: WorkerHeartbeatDTO[];
  queues: QueueCountsDTO[];
  youtube: YouTubeProviderStatusDTO | null;
}

export interface LiveSessionSummaryDTO {
  id: string;
  streamerName: string;
  title: string;
  status: SessionStatus;
  processingStatus: ProcessingStatus;
  startedAt: string | null;
  endedAt: string | null;
  clipCount: number;
}

export interface ClipSummaryDTO {
  id: string;
  title: string;
  streamerName: string;
  durationSeconds: number;
  renderStatus: RenderStatus;
  approvalStatus: ApprovalStatus;
  uploadStatus: UploadStatus;
  youtubeUrl: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface DashboardSummaryDTO {
  counts: {
    streamers: number;
    liveStreamers: number;
    sessionsWaiting: number;
    sessionsProcessing: number;
    shortsGeneratedToday: number;
    shortsPublishedToday: number;
    failedJobs: number;
  };
  recentSessions: LiveSessionSummaryDTO[];
  latestClips: ClipSummaryDTO[];
  recentUploads: ClipSummaryDTO[];
}

export interface StreamerSummaryDTO {
  id: string;
  displayName: string;
  channelId: string;
  liveStatus: LiveStatus;
}

export interface ProcessingJobDTO {
  id: string;
  jobType: JobType;
  queueName: string;
  entityType: string | null;
  entityId: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  progress: number;
  lastError: string | null;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface YouTubeConnectionDTO {
  connected: boolean;
  channelId: string | null;
  channelTitle: string | null;
  connectedAt: string | null;
}

export interface AppSettingsDTO extends AppSettingsInput {
  youtube: YouTubeConnectionDTO;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Streamers & live sessions (Phase 2)
// ---------------------------------------------------------------------------

export interface StreamerPreferencesDTO {
  maxClipsPerStream: number | null;
  minHighlightScore: number | null;
  minClipDurationSeconds: number | null;
  maxClipDurationSeconds: number | null;
  language: string | null;
}

export interface StreamerDTO {
  id: string;
  channelId: string;
  channelUrl: string;
  handle: string | null;
  displayName: string;
  thumbnailUrl: string | null;
  tags: string[];
  category: string | null;
  monitoringEnabled: boolean;
  liveStatus: LiveStatus;
  currentLiveTitle: string | null;
  currentLiveSessionId: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastLiveAt: string | null;
  lastLiveSession: { id: string; title: string; status: SessionStatus; startedAt: string | null } | null;
  totalSessions: number;
  totalProcessedStreams: number;
  consecutiveCheckFailures: number;
  lastError: string | null;
  preferences: StreamerPreferencesDTO;
  monitoringSince: string;
  createdAt: string;
}

export interface LiveSessionDTO {
  id: string;
  streamer: { id: string; displayName: string; channelId: string; thumbnailUrl: string | null };
  broadcastId: string;
  videoUrl: string;
  title: string;
  status: SessionStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  lastObservedLiveAt: string | null;
  endConfirmationCount: number;
  endReason: string | null;
  sourceMedia: { provider: string | null; status: string; lastError: string | null };
  processingStatus: ProcessingStatus;
  clipCount: number;
  reprocessCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface YouTubeProviderStatusDTO {
  provider: 'youtube' | 'mock';
  liveDetection: 'rss' | 'search';
  quotaUsedToday: number;
  dailyQuota: number;
  pausedUntil: string | null;
}

/** Dev-only mock YouTube channel state (mock provider). */
export interface MockChannelDTO {
  channelId: string;
  handle: string | null;
  title: string;
  live: { videoId: string; title: string; startedAt: string } | null;
}
