import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

export * from './secrets';

const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me-0000000000';

/** Walk up from `start` looking for a `.env` file (workspace scripts run from sub-folders). */
function findEnvFile(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // API_PORT wins over the generic PORT, which dev tooling and PaaS hosts
    // often inject into every child process.
    API_PORT: z.coerce.number().int().positive().optional(),
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

    MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/ai_shorts'),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    JWT_SECRET: optionalString,
    JWT_EXPIRES_IN_HOURS: z.coerce.number().positive().default(12),
    ENCRYPTION_KEY: optionalString.refine((v) => v === undefined || /^[0-9a-fA-F]{64}$/.test(v), {
      message: 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)',
    }),
    ADMIN_EMAIL: optionalString,
    ADMIN_PASSWORD: optionalString,

    WORKER_ROLES: z.string().default('all'),
    WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().min(2).default(10),
    STORAGE_DIR: z.string().default('./storage'),
    TEMP_FILE_MAX_AGE_HOURS: z.coerce.number().positive().default(24),

    YOUTUBE_API_KEY: optionalString,
    /** `youtube` (Data API) or `mock`. Defaults to `youtube` when an API key is set. */
    YOUTUBE_METADATA_PROVIDER: z.enum(['youtube', 'mock']).optional(),
    /** `rss` = free uploads feed + batched videos.list (1 unit/50 videos); `search` = search.list (100 units/call). */
    YOUTUBE_LIVE_DETECTION: z.enum(['rss', 'search']).default('rss'),
    YOUTUBE_DAILY_QUOTA: z.coerce.number().int().positive().default(10_000),
    YOUTUBE_CLIENT_ID: optionalString,
    YOUTUBE_CLIENT_SECRET: optionalString,
    YOUTUBE_REDIRECT_URI: optionalString,
    /** `youtube` = real uploads via OAuth; `mock` = fake uploads. Defaults to `youtube` when an OAuth client is set. */
    YOUTUBE_UPLOAD_PROVIDER: z.enum(['youtube', 'mock']).optional(),
    /** `openai` = Whisper-style /audio/transcriptions API (OpenAI, Groq, …); `mock` = offline placeholder. */
    TRANSCRIPTION_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
    TRANSCRIPTION_API_KEY: optionalString,
    TRANSCRIPTION_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    TRANSCRIPTION_MODEL: z.string().default('whisper-1'),
    TRANSCRIPTION_COST_PER_MINUTE: z.coerce.number().min(0).default(0.006),
    TRANSCRIPTION_LANGUAGE: optionalString,
    /** `anthropic` = Claude, `gemini` = Google Gemini, `mock` = offline loudness/keyword heuristic. */
    LLM_PROVIDER: z.enum(['mock', 'anthropic', 'gemini']).default('mock'),
    /** Optional: without it the Anthropic SDK reads ANTHROPIC_API_KEY. */
    LLM_API_KEY: optionalString,
    LLM_MODEL: z.string().default('claude-opus-5-5'),
    GEMINI_API_KEY: optionalString,
    GEMINI_MODEL: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : 'gemini-3.8-flash')),
    VIDEO_SOURCE_PROVIDER: z.string().default('local'),
    STORAGE_PROVIDER: z.enum(['local', 'gcs']).default('local'),
    GCS_BUCKET: optionalString,
    GCS_PROJECT_ID: optionalString,
    /** Path to a service-account JSON key. Omit on Google Cloud (uses the attached identity). */
    GOOGLE_APPLICATION_CREDENTIALS: optionalString,
    OBJECT_STORAGE_ENDPOINT: optionalString,
    OBJECT_STORAGE_BUCKET: optionalString,
    OBJECT_STORAGE_ACCESS_KEY: optionalString,
    OBJECT_STORAGE_SECRET_KEY: optionalString,

    /** Optional Telegram alerts: bot token from @BotFather and the chat id to message. */
    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_CHAT_ID: optionalString,

    MAX_CONCURRENT_TRANSCODE_JOBS: z.coerce.number().int().positive().default(2),
    CHANNEL_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(300),
    DEFAULT_MAX_CLIPS_PER_STREAM: z.coerce.number().int().positive().default(5),
    DEFAULT_MIN_HIGHLIGHT_SCORE: z.coerce.number().int().min(0).max(100).default(65),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_PROVIDER === 'gcs' && !env.GCS_BUCKET) {
      ctx.addIssue({ code: 'custom', path: ['GCS_BUCKET'], message: 'GCS_BUCKET is required when STORAGE_PROVIDER=gcs' });
    }
    if (env.TRANSCRIPTION_PROVIDER === 'openai' && !env.TRANSCRIPTION_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['TRANSCRIPTION_API_KEY'], message: 'TRANSCRIPTION_API_KEY is required when TRANSCRIPTION_PROVIDER=openai' });
    }
    if (env.LLM_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'GEMINI_API_KEY is required when LLM_PROVIDER=gemini' });
    }
    if (env.YOUTUBE_UPLOAD_PROVIDER === 'youtube' && (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['YOUTUBE_CLIENT_ID'], message: 'YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are required when YOUTUBE_UPLOAD_PROVIDER=youtube' });
    }
    if ((env.YOUTUBE_UPLOAD_PROVIDER ?? (env.YOUTUBE_CLIENT_ID ? 'youtube' : 'mock')) === 'youtube' && !env.ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEY'], message: 'ENCRYPTION_KEY is required to store the YouTube refresh token' });
    }
    if (env.YOUTUBE_METADATA_PROVIDER === 'youtube' && !env.YOUTUBE_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['YOUTUBE_API_KEY'], message: 'YOUTUBE_API_KEY is required when YOUTUBE_METADATA_PROVIDER=youtube' });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'JWT_SECRET (>= 32 chars) is required in production' });
      }
      if (!env.ENCRYPTION_KEY) {
        ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEY'], message: 'ENCRYPTION_KEY is required in production' });
      }
    } else if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'JWT_SECRET must be at least 32 characters' });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  webOrigin: string;
  mongoUri: string;
  redisUrl: string;
  auth: { jwtSecret: string; jwtExpiresInHours: number; usingDevSecret: boolean };
  encryptionKey?: string;
  bootstrapAdmin?: { email: string; password: string };
  worker: { roles: string[]; heartbeatSeconds: number; storageDir: string; tempFileMaxAgeHours: number };
  integrations: {
    youtube: {
      apiKey?: string;
      clientId?: string;
      clientSecret?: string;
      redirectUri: string;
      uploadProvider: 'youtube' | 'mock';
      metadataProvider: 'youtube' | 'mock';
      liveDetection: 'rss' | 'search';
      dailyQuota: number;
    };
    transcription: { provider: 'mock' | 'openai'; apiKey?: string; baseUrl: string; model: string; costPerMinuteUsd: number; language?: string };
    llm: { provider: 'mock' | 'anthropic' | 'gemini'; apiKey?: string; model: string; gemini: { apiKey?: string; model: string } };
    videoSource: { provider: string };
    storage: { provider: 'local' | 'gcs'; bucket?: string; projectId?: string; keyFile?: string };
    notifications: { telegramBotToken?: string; telegramChatId?: string };
    objectStorage: { endpoint?: string; bucket?: string; accessKey?: string; secretKey?: string };
  };
  defaults: {
    maxConcurrentTranscodeJobs: number;
    channelMonitorIntervalSeconds: number;
    maxClipsPerStream: number;
    minHighlightScore: number;
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse an env-like object into a typed config. Pure; does not read files.
 * Relative paths (STORAGE_DIR) resolve against `baseDir` — the project root
 * when loaded via `loadConfig`, so every workspace process agrees.
 */
export function parseConfig(source: Record<string, string | undefined>, baseDir = process.cwd()): AppConfig {
  // Blank values (`FOO=` in .env) mean "unset", so defaults and auto-detection apply.
  const cleaned = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v?.trim() === '' ? undefined : v]));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = result.data;
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.API_PORT ?? e.PORT,
    logLevel: e.LOG_LEVEL,
    webOrigin: e.WEB_ORIGIN,
    mongoUri: e.MONGODB_URI,
    redisUrl: e.REDIS_URL,
    auth: {
      jwtSecret: e.JWT_SECRET ?? DEV_JWT_SECRET,
      jwtExpiresInHours: e.JWT_EXPIRES_IN_HOURS,
      usingDevSecret: !e.JWT_SECRET,
    },
    encryptionKey: e.ENCRYPTION_KEY,
    bootstrapAdmin: e.ADMIN_EMAIL && e.ADMIN_PASSWORD ? { email: e.ADMIN_EMAIL, password: e.ADMIN_PASSWORD } : undefined,
    worker: {
      roles: e.WORKER_ROLES.split(',').map((r) => r.trim()).filter(Boolean),
      heartbeatSeconds: e.WORKER_HEARTBEAT_SECONDS,
      storageDir: path.resolve(baseDir, e.STORAGE_DIR),
      tempFileMaxAgeHours: e.TEMP_FILE_MAX_AGE_HOURS,
    },
    integrations: {
      youtube: {
        apiKey: e.YOUTUBE_API_KEY,
        clientId: e.YOUTUBE_CLIENT_ID,
        clientSecret: e.YOUTUBE_CLIENT_SECRET,
        redirectUri: e.YOUTUBE_REDIRECT_URI ?? `http://localhost:${e.API_PORT ?? e.PORT}/api/v1/integrations/youtube/callback`,
        uploadProvider: e.YOUTUBE_UPLOAD_PROVIDER ?? (e.YOUTUBE_CLIENT_ID && e.YOUTUBE_CLIENT_SECRET ? 'youtube' : 'mock'),
        metadataProvider: e.YOUTUBE_METADATA_PROVIDER ?? (e.YOUTUBE_API_KEY ? 'youtube' : 'mock'),
        liveDetection: e.YOUTUBE_LIVE_DETECTION,
        dailyQuota: e.YOUTUBE_DAILY_QUOTA,
      },
      transcription: {
        provider: e.TRANSCRIPTION_PROVIDER,
        apiKey: e.TRANSCRIPTION_API_KEY,
        baseUrl: e.TRANSCRIPTION_BASE_URL,
        model: e.TRANSCRIPTION_MODEL,
        costPerMinuteUsd: e.TRANSCRIPTION_COST_PER_MINUTE,
        language: e.TRANSCRIPTION_LANGUAGE,
      },
      llm: {
        provider: e.LLM_PROVIDER,
        apiKey: e.LLM_API_KEY,
        model: e.LLM_PROVIDER === 'gemini' ? e.GEMINI_MODEL : e.LLM_MODEL,
        gemini: { apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL },
      },
      videoSource: { provider: e.VIDEO_SOURCE_PROVIDER },
      storage: { provider: e.STORAGE_PROVIDER, bucket: e.GCS_BUCKET, projectId: e.GCS_PROJECT_ID, keyFile: e.GOOGLE_APPLICATION_CREDENTIALS },
      notifications: { telegramBotToken: e.TELEGRAM_BOT_TOKEN, telegramChatId: e.TELEGRAM_CHAT_ID },
      objectStorage: {
        endpoint: e.OBJECT_STORAGE_ENDPOINT,
        bucket: e.OBJECT_STORAGE_BUCKET,
        accessKey: e.OBJECT_STORAGE_ACCESS_KEY,
        secretKey: e.OBJECT_STORAGE_SECRET_KEY,
      },
    },
    defaults: {
      maxConcurrentTranscodeJobs: e.MAX_CONCURRENT_TRANSCODE_JOBS,
      channelMonitorIntervalSeconds: e.CHANNEL_MONITOR_INTERVAL_SECONDS,
      maxClipsPerStream: e.DEFAULT_MAX_CLIPS_PER_STREAM,
      minHighlightScore: e.DEFAULT_MIN_HIGHLIGHT_SCORE,
    },
  };
}

let cached: AppConfig | undefined;

/** Load `.env` (searching upward from cwd) and return the validated, cached config. */
export function loadConfig(options: { reload?: boolean } = {}): AppConfig {
  if (cached && !options.reload) return cached;
  const envFile = findEnvFile(process.cwd());
  if (envFile) loadDotenv({ path: envFile, quiet: true } as Parameters<typeof loadDotenv>[0]);
  cached = parseConfig(process.env, envFile ? path.dirname(envFile) : process.cwd());
  return cached;
}
