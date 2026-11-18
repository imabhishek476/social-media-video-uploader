import { AppSettingsModel, IntegrationCredentialModel } from '@shorts/database';
import {
  PrivacyStatus,
  PublishingMode,
  ReframingMode,
  SubtitlePosition,
  appSettingsSchema,
  validateSettingsInvariants,
  type AppSettingsDTO,
  type AppSettingsInput,
  type SettingsUpdateInput,
} from '@shorts/shared-types';
import type { AppConfig } from '@shorts/config';
import { DomainError } from './errors';

const SETTINGS_KEY = 'global';

/** Defaults follow spec §25 "default starting assumptions". */
export function defaultSettings(config: AppConfig): AppSettingsInput {
  return {
    monitoring: {
      intervalSeconds: config.defaults.channelMonitorIntervalSeconds,
      endConfirmationChecks: 3,
      sessionWatchIntervalSeconds: 60,
    },
    processing: {
      maxConcurrentJobs: config.defaults.maxConcurrentTranscodeJobs,
      maxSourceDurationMinutes: 8 * 60,
      maxSourceFileSizeMb: 20_000,
    },
    clips: {
      defaultDurationSeconds: 45,
      minDurationSeconds: 30,
      maxDurationSeconds: 60,
      maxClipsPerStream: config.defaults.maxClipsPerStream,
      minHighlightScore: config.defaults.minHighlightScore,
      reframingMode: ReframingMode.CENTER_CROP,
    },
    subtitles: {
      language: 'en',
      fontFamily: 'Montserrat',
      fontSize: 64,
      primaryColor: '#FFFFFF',
      highlightColor: '#FFD400',
      position: SubtitlePosition.MIDDLE,
    },
    publishing: {
      mode: PublishingMode.MANUAL_APPROVAL,
      privacyStatus: PrivacyStatus.PRIVATE,
      dailyUploadLimit: 10,
      minMinutesBetweenUploads: 60,
      categoryId: '20',
    },
    providers: {
      transcription: config.integrations.transcription.provider,
      llm: config.integrations.llm.provider,
      videoSource: config.integrations.videoSource.provider,
    },
    retention: { sourceDays: 7, clipDays: 90, transcriptDays: 90 },
  };
}

/** Section-wise merge: stored values win over defaults, so newly added fields get defaults. */
function mergeSettings(base: AppSettingsInput, patch: Partial<Record<keyof AppSettingsInput, object>>): AppSettingsInput {
  const out = { ...base } as Record<string, object>;
  for (const [section, values] of Object.entries(patch)) {
    if (values && typeof values === 'object') out[section] = { ...(out[section] ?? {}), ...values };
  }
  return out as AppSettingsInput;
}

export class SettingsService {
  constructor(private readonly config: AppConfig) {}

  async getValues(): Promise<{ values: AppSettingsInput; updatedAt: Date | null }> {
    const doc = await AppSettingsModel.findOneAndUpdate(
      { key: SETTINGS_KEY },
      { $setOnInsert: { key: SETTINGS_KEY, values: defaultSettings(this.config) } },
      { upsert: true, new: true },
    ).lean();
    const merged = mergeSettings(defaultSettings(this.config), (doc?.values ?? {}) as Record<string, object>);
    return { values: merged, updatedAt: doc?.updatedAt ?? null };
  }

  async get(): Promise<AppSettingsDTO> {
    const [{ values, updatedAt }, yt] = await Promise.all([
      this.getValues(),
      IntegrationCredentialModel.findOne({ provider: 'youtube', status: 'ACTIVE' }).lean(),
    ]);
    return {
      ...values,
      youtube: {
        connected: Boolean(yt),
        channelId: yt?.accountId ?? null,
        channelTitle: yt?.accountTitle ?? null,
        connectedAt: yt?.connectedAt ? yt.connectedAt.toISOString() : null,
      },
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
    };
  }

  async update(patch: SettingsUpdateInput, userId: string): Promise<AppSettingsDTO> {
    const { values } = await this.getValues();
    const merged = mergeSettings(values, patch);
    const parsed = appSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', 'Invalid settings', 400, parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const invariantErrors = validateSettingsInvariants(parsed.data);
    if (invariantErrors.length) {
      throw new DomainError('VALIDATION_FAILED', 'Invalid settings', 400, invariantErrors.map((message) => ({ path: '', message })));
    }
    await AppSettingsModel.updateOne({ key: SETTINGS_KEY }, { $set: { values: parsed.data, updatedBy: userId } });
    return this.get();
  }
}
