import { z } from 'zod';
import { LiveStatus, PrivacyStatus, PublishingMode, ReframingMode, SessionStatus, SubtitlePosition, enumValues } from './enums';

/** Request validation contracts shared by the API and the dashboard. */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #FFD400');

/** Full settings shape (non-secret). Secrets never live in this document. */
export const appSettingsSchema = z.object({
  monitoring: z.object({
    intervalSeconds: z.number().int().min(30).max(86_400),
    endConfirmationChecks: z.number().int().min(1).max(10),
    sessionWatchIntervalSeconds: z.number().int().min(15).max(3600),
  }),
  processing: z.object({
    maxConcurrentJobs: z.number().int().min(1).max(32),
    maxSourceDurationMinutes: z.number().int().min(1).max(24 * 60),
    maxSourceFileSizeMb: z.number().int().min(1).max(500_000),
  }),
  clips: z.object({
    defaultDurationSeconds: z.number().int().min(5).max(180),
    minDurationSeconds: z.number().int().min(5).max(180),
    maxDurationSeconds: z.number().int().min(5).max(180),
    maxClipsPerStream: z.number().int().min(1).max(50),
    minHighlightScore: z.number().int().min(0).max(100),
    reframingMode: z.enum(enumValues(ReframingMode) as [ReframingMode, ...ReframingMode[]]),
  }),
  subtitles: z.object({
    language: z.string().trim().min(2).max(10),
    fontFamily: z.string().trim().min(1).max(80),
    fontSize: z.number().int().min(12).max(160),
    primaryColor: hexColor,
    highlightColor: hexColor,
    position: z.enum(enumValues(SubtitlePosition) as [SubtitlePosition, ...SubtitlePosition[]]),
  }),
  publishing: z.object({
    mode: z.enum(enumValues(PublishingMode) as [PublishingMode, ...PublishingMode[]]),
    privacyStatus: z.enum(enumValues(PrivacyStatus) as [PrivacyStatus, ...PrivacyStatus[]]),
    dailyUploadLimit: z.number().int().min(0).max(100),
    minMinutesBetweenUploads: z.number().int().min(0).max(24 * 60),
    categoryId: z.string().trim().max(10),
  }),
  providers: z.object({
    transcription: z.string().trim().min(1).max(50),
    llm: z.string().trim().min(1).max(50),
    videoSource: z.string().trim().min(1).max(50),
  }),
  retention: z.object({
    sourceDays: z.number().int().min(0).max(3650),
    clipDays: z.number().int().min(0).max(3650),
    transcriptDays: z.number().int().min(0).max(3650),
  }),
});
export type AppSettingsInput = z.infer<typeof appSettingsSchema>;

/** PATCH /settings — any subset of sections/fields. */
export const settingsUpdateSchema = z
  .object({
    monitoring: appSettingsSchema.shape.monitoring.partial(),
    processing: appSettingsSchema.shape.processing.partial(),
    clips: appSettingsSchema.shape.clips.partial(),
    subtitles: appSettingsSchema.shape.subtitles.partial(),
    publishing: appSettingsSchema.shape.publishing.partial(),
    providers: appSettingsSchema.shape.providers.partial(),
    retention: appSettingsSchema.shape.retention.partial(),
  })
  .partial()
  .strict();
export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;

/** Cross-field rules that must hold after merging an update into current settings. */
export function validateSettingsInvariants(s: AppSettingsInput): string[] {
  const errors: string[] = [];
  const { minDurationSeconds: min, maxDurationSeconds: max, defaultDurationSeconds: def } = s.clips;
  if (min > max) errors.push('clips.minDurationSeconds must be <= clips.maxDurationSeconds');
  if (def < min || def > max) errors.push('clips.defaultDurationSeconds must be between min and max duration');
  return errors;
}

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

// ---------------------------------------------------------------------------
// Streamers & live sessions (Phase 2)
// ---------------------------------------------------------------------------

const nullableInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable();

/** Per-channel overrides; `null` means "use the global setting". */
export const streamerPreferencesSchema = z
  .object({
    maxClipsPerStream: nullableInt(1, 50),
    minHighlightScore: nullableInt(0, 100),
    minClipDurationSeconds: nullableInt(5, 180),
    maxClipDurationSeconds: nullableInt(5, 180),
    language: z.string().trim().min(2).max(10).nullable(),
  })
  .partial()
  .strict()
  .refine(
    (p) => p.minClipDurationSeconds == null || p.maxClipDurationSeconds == null || p.minClipDurationSeconds <= p.maxClipDurationSeconds,
    { message: 'minClipDurationSeconds must be <= maxClipDurationSeconds', path: ['minClipDurationSeconds'] },
  );
export type StreamerPreferencesInput = z.infer<typeof streamerPreferencesSchema>;

const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20);

export const createStreamerSchema = z
  .object({
    /** Channel URL, @handle, channel ID, or a video/live URL from the channel. */
    channel: z.string().trim().min(2).max(300),
    displayName: z.string().trim().min(1).max(100).optional(),
    monitoringEnabled: z.boolean().default(true),
    tags: tagsSchema.default([]),
    category: z.string().trim().max(60).nullable().optional(),
    preferences: streamerPreferencesSchema.optional(),
  })
  .strict();
export type CreateStreamerInput = z.infer<typeof createStreamerSchema>;

export const updateStreamerSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    tags: tagsSchema,
    category: z.string().trim().max(60).nullable(),
    preferences: streamerPreferencesSchema,
  })
  .partial()
  .strict();
export type UpdateStreamerInput = z.infer<typeof updateStreamerSchema>;

export const monitoringToggleSchema = z.object({ enabled: z.boolean() }).strict();

export const streamerListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  liveStatus: z.enum(enumValues(LiveStatus) as [LiveStatus, ...LiveStatus[]]).optional(),
  monitoring: z.enum(['enabled', 'paused']).optional(),
});
export type StreamerListQuery = z.infer<typeof streamerListQuerySchema>;

export const sessionListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(enumValues(SessionStatus) as [SessionStatus, ...SessionStatus[]]).optional(),
  streamerId: z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid streamer id').optional(),
});
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;

export const mockGoLiveSchema = z.object({ title: z.string().trim().min(1).max(200).optional() }).strict();
