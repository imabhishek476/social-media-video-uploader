import { LiveSessionModel, StreamerChannelModel, mongoose } from '@shorts/database';
import { ProviderError, channelUrlFor, parseChannelInput, type YouTubeMetadataProvider } from '@shorts/integrations';
import {
  LiveStatus,
  SessionStatus,
  type CreateStreamerInput,
  type Paginated,
  type StreamerDTO,
  type StreamerListQuery,
  type UpdateStreamerInput,
} from '@shorts/shared-types';
import { DomainError, isDuplicateKeyError } from './errors';
import { ACTIVE_SESSION_STATES } from './sessions';

const iso = (d?: Date | null) => (d ? d.toISOString() : null);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function providerFailure(err: unknown): DomainError {
  if (err instanceof ProviderError) {
    if (err.code === 'QUOTA_EXCEEDED' || err.code === 'PAUSED') {
      return new DomainError('YOUTUBE_QUOTA_EXCEEDED', 'YouTube API quota is exhausted; try again later', 503);
    }
    if (err.code === 'CONFIG') return new DomainError('YOUTUBE_MISCONFIGURED', 'YouTube API key is invalid or the API is not enabled', 502);
    return new DomainError('YOUTUBE_UNAVAILABLE', `Could not reach YouTube: ${err.message}`, 502);
  }
  return err as DomainError;
}

/** ChannelService (spec §10.1): parse, resolve, register, update, pause, remove. */
export class ChannelService {
  constructor(private readonly provider: YouTubeMetadataProvider) {}

  async register(input: CreateStreamerInput): Promise<{ streamer: StreamerDTO; restored: boolean }> {
    const ref = parseChannelInput(input.channel);
    if (!ref) {
      throw new DomainError(
        'INVALID_CHANNEL_INPUT',
        'Enter a YouTube channel URL, @handle, channel ID (UC…), or a video/live URL from the channel',
        400,
      );
    }

    let resolved;
    try {
      resolved = await this.provider.resolveChannel(ref);
    } catch (err) {
      throw providerFailure(err);
    }
    if (!resolved) throw new DomainError('CHANNEL_NOT_FOUND', 'No YouTube channel matches that input', 404);

    const now = new Date();
    const fields = {
      channelUrl: channelUrlFor(resolved.channelId, resolved.handle),
      handle: resolved.handle,
      displayName: input.displayName ?? resolved.title,
      thumbnailUrl: resolved.thumbnailUrl,
      tags: input.tags,
      category: input.category ?? null,
      monitoringEnabled: input.monitoringEnabled,
      ...(input.preferences ? { preferences: input.preferences } : {}),
    };

    const existing = await StreamerChannelModel.findOne({ channelId: resolved.channelId }).lean();
    if (existing && !existing.deletedAt) {
      throw new DomainError('DUPLICATE_CHANNEL', `“${existing.displayName}” is already registered`, 409, { streamerId: String(existing._id) });
    }
    if (existing) {
      // Re-adding a removed channel restores it with its history.
      await StreamerChannelModel.updateOne(
        { _id: existing._id },
        {
          $set: {
            ...fields,
            deletedAt: null,
            monitoringSince: now,
            nextCheckAt: now,
            liveStatus: LiveStatus.UNKNOWN,
            consecutiveCheckFailures: 0,
            lastError: null,
          },
        },
      );
      return { streamer: await this.get(String(existing._id)), restored: true };
    }

    try {
      const doc = await StreamerChannelModel.create({ channelId: resolved.channelId, ...fields, monitoringSince: now, nextCheckAt: now });
      return { streamer: await this.get(String(doc._id)), restored: false };
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new DomainError('DUPLICATE_CHANNEL', 'This channel is already registered', 409);
      throw err;
    }
  }

  async list(q: StreamerListQuery): Promise<Paginated<StreamerDTO>> {
    const filter: Record<string, unknown> = { deletedAt: null };
    if (q.liveStatus) filter.liveStatus = q.liveStatus;
    if (q.monitoring) filter.monitoringEnabled = q.monitoring === 'enabled';
    if (q.search) {
      const re = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ displayName: re }, { handle: re }, { channelId: re }, { tags: re }];
    }
    const [items, total] = await Promise.all([
      StreamerChannelModel.find(filter)
        // Live channels first, then alphabetical.
        .sort({ liveStatus: 1, displayName: 1 })
        .collation({ locale: 'en', strength: 2 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .populate('lastLiveSessionId', 'title status startedAt')
        .lean(),
      StreamerChannelModel.countDocuments(filter),
    ]);
    return { items: items.map(toStreamerDTO), page: q.page, pageSize: q.pageSize, total };
  }

  async get(id: string): Promise<StreamerDTO> {
    const doc = await this.findActive(id).populate('lastLiveSessionId', 'title status startedAt').lean();
    if (!doc) throw DomainError.notFound('Streamer');
    return toStreamerDTO(doc);
  }

  async update(id: string, patch: UpdateStreamerInput): Promise<StreamerDTO> {
    const $set: Record<string, unknown> = {};
    if (patch.displayName !== undefined) $set.displayName = patch.displayName;
    if (patch.tags !== undefined) $set.tags = patch.tags;
    if (patch.category !== undefined) $set.category = patch.category;
    for (const [k, v] of Object.entries(patch.preferences ?? {})) $set[`preferences.${k}`] = v;

    if (patch.preferences) {
      const current = await this.findActive(id).select('preferences').lean();
      if (!current) throw DomainError.notFound('Streamer');
      const merged = { ...(current.preferences ?? {}), ...patch.preferences };
      if (merged.minClipDurationSeconds != null && merged.maxClipDurationSeconds != null && merged.minClipDurationSeconds > merged.maxClipDurationSeconds) {
        throw new DomainError('VALIDATION_FAILED', 'minClipDurationSeconds must be <= maxClipDurationSeconds', 400);
      }
    }
    const res = await StreamerChannelModel.updateOne(this.activeFilter(id), { $set });
    if (res.matchedCount === 0) throw DomainError.notFound('Streamer');
    return this.get(id);
  }

  async setMonitoring(id: string, enabled: boolean): Promise<StreamerDTO> {
    const now = new Date();
    const res = await StreamerChannelModel.updateOne(
      this.activeFilter(id),
      enabled
        ? { $set: { monitoringEnabled: true, monitoringSince: now, nextCheckAt: now, consecutiveCheckFailures: 0, lastError: null } }
        : { $set: { monitoringEnabled: false } },
    );
    if (res.matchedCount === 0) throw DomainError.notFound('Streamer');
    return this.get(id);
  }

  /** Ask the monitor to check this channel on its next tick. */
  async checkNow(id: string): Promise<StreamerDTO> {
    const res = await StreamerChannelModel.updateOne({ ...this.activeFilter(id), monitoringEnabled: true }, { $set: { nextCheckAt: new Date() } });
    if (res.matchedCount === 0) {
      const exists = await this.findActive(id).select('_id').lean();
      if (!exists) throw DomainError.notFound('Streamer');
      throw new DomainError('MONITORING_PAUSED', 'Resume monitoring before requesting a check', 409);
    }
    return this.get(id);
  }

  /**
   * Soft delete: stop monitoring and hide the channel, keep sessions/clips.
   * A broadcast still in progress is cancelled so it isn't processed.
   */
  async remove(id: string): Promise<void> {
    const res = await StreamerChannelModel.updateOne(this.activeFilter(id), {
      $set: { deletedAt: new Date(), monitoringEnabled: false, liveStatus: LiveStatus.UNKNOWN, currentLiveSessionId: null, currentLiveTitle: null },
    });
    if (res.matchedCount === 0) throw DomainError.notFound('Streamer');
    await LiveSessionModel.updateMany(
      { streamerChannelId: id, status: { $in: ACTIVE_SESSION_STATES } },
      { $set: { status: SessionStatus.CANCELLED, watchLeaseId: null, lastError: 'Streamer removed while live' } },
    );
  }

  private activeFilter(id: string) {
    if (!mongoose.isValidObjectId(id)) throw DomainError.notFound('Streamer');
    return { _id: id, deletedAt: null };
  }

  private findActive(id: string) {
    return StreamerChannelModel.findOne(this.activeFilter(id));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toStreamerDTO(c: any): StreamerDTO {
  const last = c.lastLiveSessionId && typeof c.lastLiveSessionId === 'object' && 'status' in c.lastLiveSessionId ? c.lastLiveSessionId : null;
  const p = c.preferences ?? {};
  return {
    id: String(c._id),
    channelId: c.channelId,
    channelUrl: c.channelUrl,
    handle: c.handle ?? null,
    displayName: c.displayName,
    thumbnailUrl: c.thumbnailUrl ?? null,
    tags: c.tags ?? [],
    category: c.category ?? null,
    monitoringEnabled: c.monitoringEnabled,
    liveStatus: c.liveStatus,
    currentLiveTitle: c.currentLiveTitle ?? null,
    currentLiveSessionId: c.currentLiveSessionId ? String(c.currentLiveSessionId) : null,
    lastCheckedAt: iso(c.lastCheckedAt),
    nextCheckAt: iso(c.nextCheckAt),
    lastLiveAt: iso(c.lastLiveAt),
    lastLiveSession: last ? { id: String(last._id), title: last.title ?? '', status: last.status, startedAt: iso(last.startedAt) } : null,
    totalSessions: c.totalSessions ?? 0,
    totalProcessedStreams: c.totalProcessedStreams ?? 0,
    consecutiveCheckFailures: c.consecutiveCheckFailures ?? 0,
    lastError: c.lastError ?? null,
    preferences: {
      maxClipsPerStream: p.maxClipsPerStream ?? null,
      minHighlightScore: p.minHighlightScore ?? null,
      minClipDurationSeconds: p.minClipDurationSeconds ?? null,
      maxClipDurationSeconds: p.maxClipDurationSeconds ?? null,
      language: p.language ?? null,
    },
    monitoringSince: (c.monitoringSince ?? c.createdAt).toISOString(),
    createdAt: c.createdAt.toISOString(),
  };
}
