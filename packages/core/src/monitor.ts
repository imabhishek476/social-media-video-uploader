import crypto from 'node:crypto';
import { LiveSessionModel, StreamerChannelModel } from '@shorts/database';
import { ProviderError, type QuotaTracker, type VideoDetails, type YouTubeMetadataProvider } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { LiveStatus } from '@shorts/shared-types';
import { ACTIVE_SESSION_STATES, type LiveSessionService } from './sessions';
import type { SettingsService } from './settings';

export interface MonitorDeps {
  provider: YouTubeMetadataProvider;
  quota: QuotaTracker;
  settings: SettingsService;
  sessions: LiveSessionService;
  /** Daily quota budget; checks stop at 98 % to leave headroom for uploads. */
  dailyQuota: number;
  logger?: Logger;
  /** Channels checked per tick. */
  batchSize?: number;
  /** Parallel discovery requests. */
  concurrency?: number;
  /** Deterministic jitter in tests. */
  random?: () => number;
}

export interface MonitorSummary {
  skipped?: 'paused' | 'quota';
  checked: number;
  live: number;
  newSessions: number;
  failed: number;
}

/** Consecutive failures after which a channel's status becomes UNKNOWN. */
export const UNKNOWN_AFTER_FAILURES = 3;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const describe = (err: unknown) => (err instanceof ProviderError ? `[${err.code}] ${err.message}` : (err as Error)?.message ?? String(err));

/**
 * Live monitor (spec §6 Workflow B, §10.2).
 *
 * Per tick: claim due channels → cheap discovery per channel (RSS) → ONE
 * batched videos lookup for all candidates → upsert sessions for live
 * broadcasts → schedule the next check (with jitter, or backoff on errors).
 */
export class LiveMonitorService {
  constructor(private readonly deps: MonitorDeps) {}

  async tick(now = new Date()): Promise<MonitorSummary> {
    const summary: MonitorSummary = { checked: 0, live: 0, newSessions: 0, failed: 0 };
    const { provider, quota, logger } = this.deps;

    if (await quota.pausedUntil()) return { ...summary, skipped: 'paused' };
    if (provider.name === 'youtube' && (await quota.usedToday()) >= this.deps.dailyQuota * 0.98) {
      logger?.warn('YouTube daily quota nearly exhausted; skipping monitor tick');
      return { ...summary, skipped: 'quota' };
    }

    const { monitoring } = (await this.deps.settings.getValues()).values;
    const intervalMs = monitoring.intervalSeconds * 1000;

    // Claim due channels atomically so overlapping ticks/replicas never double-check one.
    const leaseId = crypto.randomUUID();
    const due = await StreamerChannelModel.find({ monitoringEnabled: true, deletedAt: null, nextCheckAt: { $lte: now } })
      .sort({ nextCheckAt: 1 })
      .limit(this.deps.batchSize ?? 100)
      .select('_id')
      .lean();
    if (due.length === 0) return summary;
    await StreamerChannelModel.updateMany(
      { _id: { $in: due.map((d) => d._id) }, nextCheckAt: { $lte: now } },
      { $set: { checkLeaseId: leaseId, nextCheckAt: new Date(now.getTime() + LEASE_MS) } },
    );
    const channels = await StreamerChannelModel.find({ checkLeaseId: leaseId }).lean();

    const discovered = await mapLimit(channels, this.deps.concurrency ?? 5, async (ch) => {
      try {
        return { ch, ids: await provider.listCandidateVideoIds(ch.channelId), error: null as unknown };
      } catch (error) {
        return { ch, ids: [] as string[], error };
      }
    });

    let videos = new Map<string, VideoDetails>();
    let batchError: unknown = null;
    const allIds = [...new Set(discovered.flatMap((d) => d.ids))];
    if (allIds.length > 0) {
      try {
        videos = new Map((await provider.getVideos(allIds)).map((v) => [v.videoId, v]));
      } catch (err) {
        batchError = err;
      }
    }

    for (const d of discovered) {
      summary.checked++;
      const error = d.error ?? batchError;
      if (error) {
        summary.failed++;
        await this.markFailure(d.ch, error, now, intervalMs);
        continue;
      }
      const channelVideos = d.ids.map((id) => videos.get(id)).filter((v): v is VideoDetails => Boolean(v) && v!.channelId === d.ch.channelId);
      const r = await this.processChannel(d.ch, channelVideos, now, intervalMs);
      if (r.live) summary.live++;
      summary.newSessions += r.newSessions;
    }

    if (summary.checked) logger?.info(summary, 'Monitor tick complete');
    return summary;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processChannel(ch: any, videos: VideoDetails[], now: Date, intervalMs: number) {
    const { sessions } = this.deps;
    let newSessions = 0;

    const live = videos.filter((v) => v.liveBroadcastContent === 'live' && v.actualStartTime && !v.actualEndTime);
    let current: { id: string; title: string } | null = null;
    for (const v of live) {
      const r = await sessions.recordLive(ch, v, now);
      if (r.created) newSessions++;
      current ??= { id: r.id, title: v.title };
    }

    // Streams that started after monitoring began but finished between checks.
    const since: Date = ch.monitoringSince ?? ch.createdAt;
    const missed = videos.filter((v) => v.actualEndTime && v.actualStartTime && v.actualStartTime >= since);
    for (const v of missed) {
      const r = await sessions.recordMissed(ch, v, now);
      if (r.created) newSessions++;
    }

    const base = {
      lastCheckedAt: now,
      nextCheckAt: this.nextCheck(now, intervalMs),
      consecutiveCheckFailures: 0,
      lastError: null,
      checkLeaseId: null,
    };

    if (current) {
      await StreamerChannelModel.updateOne(
        { _id: ch._id },
        { $set: { ...base, liveStatus: LiveStatus.LIVE, currentLiveSessionId: current.id, currentLiveTitle: current.title, lastLiveAt: now, lastLiveSessionId: current.id } },
      );
    } else {
      // An active session that discovery no longer lists stays LIVE until the
      // session watcher confirms the end — the monitor never ends sessions.
      const active = await LiveSessionModel.exists({ streamerChannelId: ch._id, status: { $in: ACTIVE_SESSION_STATES } });
      await StreamerChannelModel.updateOne(
        { _id: ch._id },
        { $set: active ? { ...base, liveStatus: LiveStatus.LIVE } : { ...base, liveStatus: LiveStatus.OFFLINE, currentLiveSessionId: null, currentLiveTitle: null } },
      );
    }
    return { live: Boolean(current), newSessions };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async markFailure(ch: any, error: unknown, now: Date, intervalMs: number) {
    const message = describe(error);
    const globalPause = error instanceof ProviderError && (error.code === 'QUOTA_EXCEEDED' || error.code === 'PAUSED');
    const failures = globalPause ? ch.consecutiveCheckFailures ?? 0 : (ch.consecutiveCheckFailures ?? 0) + 1;
    const backoff = globalPause ? 30 * 60 * 1000 : Math.min(intervalMs * 2 ** Math.min(failures - 1, 5), Math.max(MAX_BACKOFF_MS, intervalMs));
    const active = await LiveSessionModel.exists({ streamerChannelId: ch._id, status: { $in: ACTIVE_SESSION_STATES } });

    await StreamerChannelModel.updateOne(
      { _id: ch._id },
      {
        $set: {
          lastCheckedAt: now,
          nextCheckAt: new Date(now.getTime() + backoff),
          consecutiveCheckFailures: failures,
          lastError: message.slice(0, 500),
          checkLeaseId: null,
          ...(failures >= UNKNOWN_AFTER_FAILURES && !active ? { liveStatus: LiveStatus.UNKNOWN } : {}),
        },
      },
    );
    this.deps.logger?.warn({ channelId: ch.channelId, failures, err: message }, 'Channel check failed');
  }

  /** ±10 % jitter spreads checks so channels added together don't poll in lockstep. */
  private nextCheck(now: Date, intervalMs: number): Date {
    const r = this.deps.random?.() ?? Math.random();
    return new Date(now.getTime() + intervalMs * (0.9 + r * 0.2));
  }
}
