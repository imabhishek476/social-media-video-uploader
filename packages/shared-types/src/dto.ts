import type {
  ApprovalStatus,
  CandidateStatus,
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
  liveSessionId: string;
  views: number | null;
  likes: number | null;
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
    /** Rendered Shorts with metadata waiting for an admin to approve or reject. */
    awaitingReview: number;
    /** Approved and waiting for a publish slot or uploading. */
    queuedUploads: number;
  };
  costs: { spentUsd: number; budgetUsd: number };
  topShorts: ClipSummaryDTO[];
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
  /** OAuth client id/secret are configured, so Connect can be used. */
  oauthConfigured: boolean;
  status: 'ACTIVE' | 'REVOKED' | 'ERROR' | null;
  lastError: string | null;
  connected: boolean;
  channelId: string | null;
  channelTitle: string | null;
  connectedAt: string | null;
}

export interface InstagramConnectionDTO {
  connected: boolean;
  status: 'ACTIVE' | 'REVOKED' | 'ERROR' | null;
  userId: string | null;
  username: string | null;
  tokenExpiresAt: string | null;
  lastError: string | null;
}

export type InstagramPostStatus = 'NOT_POSTED' | 'QUEUED' | 'POSTING' | 'PUBLISHED' | 'FAILED';

export interface AppSettingsDTO extends AppSettingsInput {
  youtube: YouTubeConnectionDTO;
  instagram: InstagramConnectionDTO;
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
  game: string | null;
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
  sourceMedia: {
    provider: string | null;
    status: string;
    lastError: string | null;
    durationSeconds: number | null;
    fileSizeBytes: number | null;
    width: number | null;
    height: number | null;
    videoCodec: string | null;
    storedIn: 'local' | 'gcs' | null;
    progress: {
      phase: 'DOWNLOADING' | 'MERGING' | 'STORING';
      percent: number | null;
      downloadedBytes: number | null;
      totalBytes: number | null;
      speedBytesPerSec: number | null;
      etaSeconds: number | null;
      updatedAt: string;
    } | null;
  };
  processingStatus: ProcessingStatus;
  processingStage: string | null;
  highlightCount: number;
  /** Facecam box for the split layout; source `none` = looked and found no webcam. */
  facecam: { x: number; y: number; w: number; h: number; source: 'detected' | 'manual' | 'none' } | null;
  /** Layout chosen for this session; null = the Settings default. */
  reframingMode: string | null;
  clipCount: number;
  estimatedCostUsd: number;
  reprocessCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface YouTubeProviderStatusDTO {
  provider: string;
  liveDetection: 'rss' | 'search';
  quotaUsedToday: number;
  dailyQuota: number;
  pausedUntil: string | null;
}

export interface HighlightCandidateDTO {
  id: string;
  liveSessionId: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  keyMomentSeconds: number | null;
  score: number;
  scoreBreakdown: Record<string, number>;
  reason: string;
  hook: string;
  topic: string | null;
  transcriptExcerpt: string;
  status: CandidateStatus;
  discardReason: string | null;
  analysisProvider: string | null;
  userAdjusted: boolean;
  createdAt: string;
}

export interface TranscriptSegmentDTO {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TranscriptDTO {
  liveSessionId: string;
  provider: string;
  language: string;
  durationSeconds: number | null;
  segmentCount: number;
  segments: TranscriptSegmentDTO[];
}

export interface SourcePreviewDTO {
  url: string;
  expiresAt: string | null;
}

export interface GeneratedClipDTO {
  id: string;
  liveSessionId: string;
  highlightCandidateId: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  highlightScore: number | null;
  reframingMode: string;
  renderStatus: RenderStatus;
  renderVersion: number;
  fileSizeBytes: number | null;
  width: number | null;
  height: number | null;
  renderedAt: string | null;
  approvalStatus: ApprovalStatus;
  approvedAt: string | null;
  uploadStatus: UploadStatus;
  title: string;
  description: string;
  tags: string[];
  metadataEditedByUser: boolean;
  scheduledPublishAt: string | null;
  youtubeVideoId: string | null;
  youtubeUrl: string | null;
  publishedAt: string | null;
  stats: { views: number; likes: number; comments: number; privacyStatus: string | null; fetchedAt: string } | null;
  instagram: { status: InstagramPostStatus; permalink: string | null; publishedAt: string | null; lastError: string | null };
  filesExpired: boolean;
  lastError: string | null;
  createdAt: string;
}

export interface ClipMediaDTO {
  videoUrl: string;
  thumbnailUrl: string | null;
  expiresAt: string | null;
}
