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
    /** Live-chat sampling interval while a stream is live; 0 turns it off. */
    chatPollSeconds: z.number().int().min(0).max(600).refine((n) => n === 0 || n >= 30, 'Use 0 (off) or at least 30 seconds'),
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
    /** HYPE / BOUNCE / CLEAN presets, or CUSTOM = the font, size and colours above. */
    captionStyle: z.enum(['STREAMER', 'HYPE', 'BOUNCE', 'CLEAN', 'CUSTOM']),
    /** Hook text box at the top: whole clip, first 4 s, or off. */
    hookOverlay: z.enum(['ALWAYS', 'INTRO', 'OFF']),
  }),
  publishing: z.object({
    mode: z.enum(enumValues(PublishingMode) as [PublishingMode, ...PublishingMode[]]),
    privacyStatus: z.enum(enumValues(PrivacyStatus) as [PrivacyStatus, ...PrivacyStatus[]]),
    dailyUploadLimit: z.number().int().min(0).max(100),
    minMinutesBetweenUploads: z.number().int().min(0).max(24 * 60),
    categoryId: z.string().trim().max(10),
    /** Uploads only start inside [windowStartHour, windowEndHour) in `timezone`. 0–24 = any time. */
    windowStartHour: z.number().int().min(0).max(23),
    windowEndHour: z.number().int().min(1).max(24),
    timezone: z.string().trim().min(1).max(60).refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone (use an IANA name like Asia/Kolkata)'),
    /** MANUAL: post to Instagram from Clip Studio only; WITH_YOUTUBE: approving a clip also queues the Reel. */
    instagramMode: z.enum(['MANUAL', 'WITH_YOUTUBE']),
    /** Channel branding added to every new Short's description (above the hashtags). */
    descriptionFooter: z.string().max(1000),
    /** Channel hashtags added to every new Short (comma or space separated, without #). */
    channelHashtags: z.string().max(200),
  }),
  costs: z.object({
    /** Month-to-date AI spend (transcription + LLM) at which processing pauses. 0 = no cap. */
    monthlyBudgetUsd: z.number().min(0).max(100_000),
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
    /** Delete the raw recording this many days after every Short of the stream is published or rejected. 0 = only use sourceDays. */
    sourceAfterDoneDays: z.number().int().min(0).max(3650),
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
    costs: appSettingsSchema.shape.costs.partial(),
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
  if (s.publishing.windowStartHour >= s.publishing.windowEndHour) errors.push('publishing.windowStartHour must be before publishing.windowEndHour');
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
    game: z.string().trim().min(2).max(60).nullable(),
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

/** Manual facecam box (fractions of the frame), or `null` to detect again on the next render. */
export const facecamUpdateSchema = z
  .object({
    box: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.03).max(1), h: z.number().min(0.03).max(1) })
      .refine((b) => b.x + b.w <= 1.001 && b.y + b.h <= 1.001, 'Box must stay inside the frame')
      .nullable(),
  })
  .strict();

/** Register a missed broadcast by URL or video id. */
export const sessionImportSchema = z.object({ url: z.string().trim().min(5).max(500) }).strict();

/** Clip Studio edits to one highlight candidate (spec §16). */
export const candidateUpdateSchema = z
  .object({
    status: z.enum(['CANDIDATE', 'SELECTED', 'DISCARDED']).optional(),
    startSeconds: z.number().min(0).optional(),
    endSeconds: z.number().min(0).optional(),
    discardReason: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  .refine((v) => v.startSeconds === undefined || v.endSeconds === undefined || v.endSeconds > v.startSeconds, {
    message: 'End must be after start',
    path: ['endSeconds'],
  });
export type CandidateUpdateInput = z.infer<typeof candidateUpdateSchema>;

export const transcriptQuerySchema = z.object({
  from: z.coerce.number().min(0).optional(),
  to: z.coerce.number().min(0).optional(),
});

/** Clip Studio edits to a Short's YouTube metadata (Phase 6). */
export const clipMetadataSchema = z
  .object({
    title: z.string().max(100).optional(),
    description: z.string().max(5000).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type ClipMetadataInput = z.infer<typeof clipMetadataSchema>;

/** Paste a long-lived Instagram access token (Instagram API with Instagram Login). */
export const instagramConnectSchema = z.object({ accessToken: z.string().trim().min(20).max(1000) }).strict();
export type InstagramConnectInput = z.infer<typeof instagramConnectSchema>;
