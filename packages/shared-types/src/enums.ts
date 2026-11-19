/**
 * Domain enums shared by API, workers and dashboard. Declared as `const`
 * objects so they exist at runtime (for Mongoose enums / UI) and as types.
 */
type ValueOf<T> = T[keyof T];

export const enumValues = <T extends Record<string, string>>(e: T) => Object.values(e) as ValueOf<T>[];

export const UserRole = { ADMIN: 'ADMIN', VIEWER: 'VIEWER' } as const;
export type UserRole = ValueOf<typeof UserRole>;

export const LiveStatus = { OFFLINE: 'OFFLINE', LIVE: 'LIVE', UNKNOWN: 'UNKNOWN' } as const;
export type LiveStatus = ValueOf<typeof LiveStatus>;

/** Live session lifecycle (spec §14). */
export const SessionStatus = {
  DETECTED: 'DETECTED',
  LIVE: 'LIVE',
  ENDED: 'ENDED',
  SOURCE_PENDING: 'SOURCE_PENDING',
  SOURCE_READY: 'SOURCE_READY',
  PROCESSING: 'PROCESSING',
  /** Transcribed and analysed; highlight candidates await review/rendering (Phase 4). */
  HIGHLIGHTS_READY: 'HIGHLIGHTS_READY',
  COMPLETED: 'COMPLETED',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type SessionStatus = ValueOf<typeof SessionStatus>;

export const SourceMediaStatus = {
  PENDING: 'PENDING',
  DOWNLOADING: 'DOWNLOADING',
  READY: 'READY',
  UNAVAILABLE: 'UNAVAILABLE',
  FAILED: 'FAILED',
  /** Raw file deleted by retention; session metadata and clips remain. */
  EXPIRED: 'EXPIRED',
} as const;
export type SourceMediaStatus = ValueOf<typeof SourceMediaStatus>;

export const ProcessingStatus = {
  NOT_STARTED: 'NOT_STARTED',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type ProcessingStatus = ValueOf<typeof ProcessingStatus>;

/** Finer-grained step while a session is PROCESSING. */
export const ProcessingStage = { TRANSCRIBING: 'TRANSCRIBING', ANALYZING: 'ANALYZING' } as const;
export type ProcessingStage = ValueOf<typeof ProcessingStage>;

/** Step shown while clips render (session.processingStage). */
export const RENDER_STAGE = 'RENDERING';

export const CandidateStatus = { CANDIDATE: 'CANDIDATE', SELECTED: 'SELECTED', DISCARDED: 'DISCARDED' } as const;
export type CandidateStatus = ValueOf<typeof CandidateStatus>;

/** Clip rendering, approval and upload are tracked separately (spec §14). */
export const RenderStatus = {
  PENDING: 'PENDING',
  RENDERING: 'RENDERING',
  RENDERED: 'RENDERED',
  RENDER_FAILED: 'RENDER_FAILED',
} as const;
export type RenderStatus = ValueOf<typeof RenderStatus>;

export const ApprovalStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  AUTO_APPROVED: 'AUTO_APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type ApprovalStatus = ValueOf<typeof ApprovalStatus>;

export const UploadStatus = {
  NOT_UPLOADED: 'NOT_UPLOADED',
  QUEUED: 'QUEUED',
  UPLOADING: 'UPLOADING',
  PUBLISHED: 'PUBLISHED',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
} as const;
export type UploadStatus = ValueOf<typeof UploadStatus>;

export const JobType = {
  CHANNEL_MONITOR: 'CHANNEL_MONITOR',
  SESSION_WATCH: 'SESSION_WATCH',
  MEDIA_ACQUISITION: 'MEDIA_ACQUISITION',
  TRANSCRIPTION: 'TRANSCRIPTION',
  HIGHLIGHT_ANALYSIS: 'HIGHLIGHT_ANALYSIS',
  CLIP_RENDER: 'CLIP_RENDER',
  METADATA_GENERATION: 'METADATA_GENERATION',
  YOUTUBE_UPLOAD: 'YOUTUBE_UPLOAD',
  CLEANUP: 'CLEANUP',
} as const;
export type JobType = ValueOf<typeof JobType>;

export const JobStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  RETRYING: 'RETRYING',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type JobStatus = ValueOf<typeof JobStatus>;

export const PublishingMode = { MANUAL_APPROVAL: 'MANUAL_APPROVAL', AUTO_PUBLISH: 'AUTO_PUBLISH' } as const;
export type PublishingMode = ValueOf<typeof PublishingMode>;

export const PrivacyStatus = { PRIVATE: 'private', UNLISTED: 'unlisted', PUBLIC: 'public' } as const;
export type PrivacyStatus = ValueOf<typeof PrivacyStatus>;

export const ReframingMode = {
  CENTER_CROP: 'CENTER_CROP',
  /** Whole 16:9 frame centred over a blurred, zoomed copy (keeps all gameplay/HUD visible). */
  BLUR_FIT: 'BLUR_FIT',
  FACE_TRACK: 'FACE_TRACK',
  ACTIVE_SPEAKER: 'ACTIVE_SPEAKER',
  CUSTOM_LAYOUT: 'CUSTOM_LAYOUT',
} as const;
export type ReframingMode = ValueOf<typeof ReframingMode>;

export const SubtitlePosition = { BOTTOM: 'BOTTOM', MIDDLE: 'MIDDLE', TOP: 'TOP' } as const;
export type SubtitlePosition = ValueOf<typeof SubtitlePosition>;
