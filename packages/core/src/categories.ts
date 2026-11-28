import { CategoryPresetModel, GeneratedClipModel, IntegrationCredentialModel, LiveSessionModel, StreamerChannelModel } from '@shorts/database';
import { addToPlaylist, createPlaylist, detectGame } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { DomainError } from './errors';
import type { SettingsService } from './settings';

/** Phase 10: kinds of content. Each has a preset for look, length, hashtags and playlist. */
export const CATEGORIES = ['GAMING', 'IRL', 'PODCAST', 'SPORTS', 'COMEDY', 'MUSIC', 'EDUCATION', 'OTHER'] as const;
export type Category = (typeof CATEGORIES)[number];
export const isCategory = (v: unknown): v is Category => typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);

export const CATEGORY_LABELS: Record<Category, string> = {
  GAMING: 'Gaming',
  IRL: 'IRL / Reactions',
  PODCAST: 'Podcast / Talk',
  SPORTS: 'Sports',
  COMEDY: 'Comedy',
  MUSIC: 'Music',
  EDUCATION: 'Education',
  OTHER: 'Other',
};

export interface CategoryPresetDTO {
  category: Category;
  label: string;
  shortStyle: string | null;
  captionStyle: string | null;
  hookOverlay: string | null;
  minDurationSeconds: number | null;
  defaultDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  hashtags: string | null;
  descriptionFooter: string | null;
  playlist: 'ON' | 'OFF';
  playlistId: string | null;
}
export type CategoryPresetInput = Partial<Omit<CategoryPresetDTO, 'category' | 'label' | 'playlistId'>>;

/** Starting presets; anything left null follows Settings. */
const DEFAULTS: Record<Category, Partial<CategoryPresetDTO>> = {
  GAMING: { shortStyle: 'AUTO', captionStyle: 'STREAMER', hashtags: 'gaming, gameplay' },
  IRL: { shortStyle: 'AUTO', captionStyle: 'HYPE', hashtags: 'irl, streamer, funny' },
  PODCAST: { shortStyle: 'REACTION', captionStyle: 'CLEAN', hookOverlay: 'INTRO', minDurationSeconds: 20, defaultDurationSeconds: 35, maxDurationSeconds: 55, hashtags: 'podcast, clips' },
  SPORTS: { shortStyle: 'CLEAN', hashtags: 'sports, highlights' },
  COMEDY: { shortStyle: 'AUTO', captionStyle: 'BOUNCE', hashtags: 'funny, comedy' },
  MUSIC: { shortStyle: 'CLEAN', hookOverlay: 'OFF', hashtags: 'music, live' },
  EDUCATION: { shortStyle: 'AUTO', captionStyle: 'CLEAN', minDurationSeconds: 20, defaultDurationSeconds: 40, maxDurationSeconds: 58, hashtags: 'learn, facts' },
  OTHER: {},
};

const KEYWORDS: Array<[Category, RegExp]> = [
  ['PODCAST', /\b(podcast|interview|talk ?show|ep(isode)?\.? ?\d+|q ?& ?a|ama)\b/i],
  ['SPORTS', /\b(football|soccer|cricket|ipl|nba|basketball|tennis|f1|formula 1|ufc|boxing|match ?day|world cup)\b/i],
  ['MUSIC', /\b(music|song|singing|concert|karaoke|dj set|cover|album)\b/i],
  ['EDUCATION', /\b(tutorial|how to|explained|learn(ing)?|lesson|course|guide)\b/i],
  ['COMEDY', /\b(comedy|stand ?up|roast|prank|funniest|jokes?)\b/i],
  ['IRL', /\b(irl|vlog|just chatting|chatting|travel(ing|ling)?|walking|street|reacts?|reaction|watch ?party|mukbang)\b/i],
];

/**
 * Category for a stream: the streamer's own category if it names one, a known
 * game in the title or streamer settings, then title keywords. Defaults to
 * Gaming for streamers with a fixed game, else Other.
 */
export function detectCategory(input: { streamerCategory?: string | null; streamerGame?: string | null; title?: string | null }): Category {
  const sc = input.streamerCategory?.trim().toUpperCase().replace(/[^A-Z]/g, '');
  const fromStreamer = CATEGORIES.find((c) => c === sc || CATEGORY_LABELS[c].toUpperCase().replace(/[^A-Z]/g, '') === sc);
  if (fromStreamer) return fromStreamer;
  if (sc && /GAM/.test(sc)) return 'GAMING';
  if (detectGame(input.title)) return 'GAMING';
  for (const [cat, re] of KEYWORDS) if (input.title && re.test(input.title)) return cat;
  if (detectGame(input.streamerGame)) return 'GAMING';
  return 'OTHER';
}

/** The settings that change per category, after applying the preset (null = keep Settings). */
export interface EffectivePreset {
  category: Category;
  shortStyle: string | null;
  captionStyle: string | null;
  hookOverlay: string | null;
  minDurationSeconds: number | null;
  defaultDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  hashtags: string | null;
  descriptionFooter: string | null;
}

const blank = (v: string | null | undefined) => (v && v.trim() ? v : null);

export class CategoryService {
  constructor(private readonly deps: { settings: SettingsService; logger?: Logger }) {}

  async list(): Promise<CategoryPresetDTO[]> {
    const rows = new Map((await CategoryPresetModel.find().lean()).map((r) => [r._id, r]));
    return CATEGORIES.map((c) => this.toDTO(c, rows.get(c)));
  }

  async get(category: Category): Promise<CategoryPresetDTO> {
    return this.toDTO(category, await CategoryPresetModel.findById(category).lean());
  }

  async update(category: string, input: CategoryPresetInput): Promise<CategoryPresetDTO> {
    if (!isCategory(category)) throw new DomainError('VALIDATION_FAILED', `Unknown category ${category}`, 400);
    const set: Record<string, unknown> = {};
    const nums = ['minDurationSeconds', 'defaultDurationSeconds', 'maxDurationSeconds'] as const;
    for (const k of nums) {
      if (input[k] === undefined) continue;
      const v = input[k];
      if (v !== null && (!Number.isInteger(v) || v < 5 || v > 180)) throw new DomainError('VALIDATION_FAILED', `${k} must be 5–180 seconds`, 400);
      set[k] = v;
    }
    for (const k of ['shortStyle', 'captionStyle', 'hookOverlay', 'hashtags', 'descriptionFooter'] as const) if (input[k] !== undefined) set[k] = blank(input[k]);
    if (input.playlist !== undefined) {
      if (input.playlist !== 'ON' && input.playlist !== 'OFF') throw new DomainError('VALIDATION_FAILED', 'playlist must be ON or OFF', 400);
      set.playlist = input.playlist;
    }
    const merged = { ...(await this.get(category)), ...set } as CategoryPresetDTO;
    if (merged.minDurationSeconds && merged.maxDurationSeconds && merged.minDurationSeconds > merged.maxDurationSeconds) {
      throw new DomainError('VALIDATION_FAILED', 'Shortest must not be longer than Longest', 400);
    }
    await CategoryPresetModel.updateOne({ _id: category }, { $set: { ...this.stored(category, merged) } }, { upsert: true });
    return this.get(category);
  }

  /** The session's category: stored, or detected now and saved. */
  async categoryOf(sessionId: string): Promise<Category> {
    const s = await LiveSessionModel.findById(sessionId).select('category streamerChannelId title').lean();
    if (!s) return 'OTHER';
    if (isCategory(s.category)) return s.category;
    const streamer = await StreamerChannelModel.findById(s.streamerChannelId).select('category preferences.game').lean();
    const cat = detectCategory({ streamerCategory: streamer?.category, streamerGame: streamer?.preferences?.game, title: s.title });
    await LiveSessionModel.updateOne({ _id: sessionId, category: null }, { $set: { category: cat, categorySource: 'detected' } });
    return cat;
  }

  /** Give a category to sessions made before Phase 10 (runs at worker start). */
  async backfill(): Promise<number> {
    const ids = await LiveSessionModel.find({ category: null }).select('_id').limit(5000).lean();
    for (const { _id } of ids) await this.categoryOf(String(_id));
    return ids.length;
  }

  async setSessionCategory(sessionId: string, category: string): Promise<void> {
    if (!isCategory(category)) throw new DomainError('VALIDATION_FAILED', `Unknown category ${category}`, 400);
    const res = await LiveSessionModel.updateOne({ _id: sessionId }, { $set: { category, categorySource: 'manual' } });
    if (!res.matchedCount) throw DomainError.notFound('Live session');
  }

  /** Preset values for this session's category. */
  async presetFor(sessionId: string): Promise<EffectivePreset> {
    const category = await this.categoryOf(sessionId);
    const p = await this.get(category);
    return {
      category,
      shortStyle: p.shortStyle,
      captionStyle: p.captionStyle,
      hookOverlay: p.hookOverlay,
      minDurationSeconds: p.minDurationSeconds,
      defaultDurationSeconds: p.defaultDurationSeconds,
      maxDurationSeconds: p.maxDurationSeconds,
      hashtags: p.hashtags,
      descriptionFooter: p.descriptionFooter,
    };
  }

  /**
   * After upload: put the Short in its category's playlist, creating the
   * playlist on first use. Never throws (a missing playlist must not fail the upload).
   */
  async addToPlaylist(clipId: string, accessToken: () => Promise<string>): Promise<'added' | 'skipped' | 'failed'> {
    try {
      const clip = await GeneratedClipModel.findById(clipId).select('youtubeVideoId liveSessionId category playlistAdded').lean();
      if (!clip?.youtubeVideoId || clip.playlistAdded) return 'skipped';
      const category = isCategory(clip.category) ? clip.category : await this.categoryOf(String(clip.liveSessionId));
      const preset = await this.get(category);
      if (preset.playlist === 'OFF') return 'skipped';
      const token = await accessToken();
      let playlistId = preset.playlistId;
      if (!playlistId) {
        const cred = await IntegrationCredentialModel.findOne({ provider: 'youtube' }).select('accountTitle').lean();
        const channelName = (cred as { accountTitle?: string | null } | null)?.accountTitle || 'our channel';
        playlistId = await createPlaylist(`${CATEGORY_LABELS[category]} Shorts | ${channelName}`, `The best ${CATEGORY_LABELS[category].toLowerCase()} moments from ${channelName}, newest first.`, token);
        await CategoryPresetModel.updateOne({ _id: category }, { $set: { ...this.stored(category, preset), playlistId } }, { upsert: true });
      }
      await addToPlaylist(playlistId, clip.youtubeVideoId, token);
      await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { playlistAdded: true, category } });
      return 'added';
    } catch (err) {
      this.deps.logger?.warn({ clipId, err: (err as Error).message }, 'Not added to the category playlist');
      return 'failed';
    }
  }

  /** Published Shorts and their results per category (dashboard). */
  async stats(): Promise<Array<{ category: Category; label: string; shorts: number; views: number; likes: number; avgViewPercent: number | null; subscribers: number }>> {
    const rows = await GeneratedClipModel.aggregate<{ _id: string | null; shorts: number; views: number; likes: number; avgPct: number | null; subs: number }>([
      { $match: { uploadStatus: 'PUBLISHED' } },
      { $lookup: { from: 'livesessions', localField: 'liveSessionId', foreignField: '_id', as: 's', pipeline: [{ $project: { category: 1 } }] } },
      { $group: { _id: { $ifNull: ['$category', { $first: '$s.category' }] }, shorts: { $sum: 1 }, views: { $sum: { $ifNull: ['$stats.views', 0] } }, likes: { $sum: { $ifNull: ['$stats.likes', 0] } }, avgPct: { $avg: '$stats.averageViewPercentage' }, subs: { $sum: { $ifNull: ['$stats.subscribersGained', 0] } } } },
    ]);
    return rows
      .map((r) => {
        const category = isCategory(r._id) ? r._id : 'OTHER';
        return { category, label: CATEGORY_LABELS[category], shorts: r.shorts, views: r.views, likes: r.likes, avgViewPercent: r.avgPct == null ? null : Math.round(r.avgPct), subscribers: r.subs };
      })
      .sort((a, b) => b.views - a.views);
  }

  private toDTO(category: Category, row: Record<string, unknown> | null | undefined): CategoryPresetDTO {
    const d = DEFAULTS[category];
    const pick = <K extends keyof CategoryPresetDTO>(k: K): CategoryPresetDTO[K] => (row && row[k] !== undefined ? (row[k] as CategoryPresetDTO[K]) : ((d[k] ?? null) as CategoryPresetDTO[K]));
    return {
      category,
      label: CATEGORY_LABELS[category],
      shortStyle: pick('shortStyle'),
      captionStyle: pick('captionStyle'),
      hookOverlay: pick('hookOverlay'),
      minDurationSeconds: pick('minDurationSeconds'),
      defaultDurationSeconds: pick('defaultDurationSeconds'),
      maxDurationSeconds: pick('maxDurationSeconds'),
      hashtags: pick('hashtags'),
      descriptionFooter: pick('descriptionFooter'),
      playlist: (pick('playlist') as 'ON' | 'OFF' | null) ?? 'ON',
      playlistId: (row?.playlistId as string | null | undefined) ?? null,
    };
  }

  private stored(_c: Category, p: CategoryPresetDTO) {
    const { category: _a, label: _b, playlistId: _p, ...rest } = p;
    return rest;
  }
}
