import { ChatActivityModel, LiveSessionModel } from '@shorts/database';
import { CHAT_BUCKET_SECONDS, ProviderError, type LiveChatProvider, type QuotaTracker } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { SessionStatus } from '@shorts/shared-types';
import type { SettingsService } from './settings';

export interface ChatSamplerDeps {
  chat: LiveChatProvider;
  quota: QuotaTracker;
  settings: SettingsService;
  dailyQuota: number;
  logger?: Logger;
}

export interface ChatTickSummary {
  skipped?: 'off' | 'paused' | 'quota';
  polled: number;
  messages: number;
}

/** Chat sampling stops at this share of the daily quota so live detection and uploads keep working. */
const QUOTA_SHARE = 0.8;

/**
 * Samples live-chat activity for sessions that are currently LIVE (spec:
 * chat-spike highlight signal). Each poll reads all messages since the last
 * page token and adds them to per-10s counters keyed to the broadcast start.
 */
export class ChatSampler {
  constructor(private readonly deps: ChatSamplerDeps) {}

  async tick(now = new Date()): Promise<ChatTickSummary> {
    const { quota, logger } = this.deps;
    const summary: ChatTickSummary = { polled: 0, messages: 0 };
    const pollSeconds = (await this.deps.settings.getValues()).values.monitoring.chatPollSeconds ?? 60;
    if (!pollSeconds) return { ...summary, skipped: 'off' };
    if (await quota.pausedUntil()) return { ...summary, skipped: 'paused' };
    if ((await quota.usedToday()) >= this.deps.dailyQuota * QUOTA_SHARE) return { ...summary, skipped: 'quota' };

    const live = await LiveSessionModel.find({ status: SessionStatus.LIVE, startedAt: { $ne: null } }).select('_id broadcastId startedAt').lean();
    for (const s of live) {
      const act =
        (await ChatActivityModel.findOne({ liveSessionId: s._id }).lean()) ??
        (await ChatActivityModel.create({ liveSessionId: s._id, anchorAt: s.startedAt, bucketSeconds: CHAT_BUCKET_SECONDS, nextPollAt: now })).toObject();
      if (act.status !== 'ACTIVE' || act.nextPollAt > now) continue;
      try {
        const n = await this.poll(act, s.broadcastId, now, pollSeconds);
        summary.polled++;
        summary.messages += n;
      } catch (err) {
        const message = err instanceof ProviderError ? `[${err.code}] ${err.message}` : (err as Error).message;
        const permanent = err instanceof ProviderError && !err.retryable;
        await ChatActivityModel.updateOne(
          { _id: act._id },
          { $set: { lastError: message.slice(0, 300), nextPollAt: new Date(now.getTime() + pollSeconds * 3000), ...(permanent && err.code !== 'QUOTA_EXCEEDED' ? { status: 'UNAVAILABLE' } : {}) } },
        );
        logger?.warn({ liveSessionId: String(s._id), err: message }, 'Chat sampling failed');
        if (err instanceof ProviderError && (err.code === 'QUOTA_EXCEEDED' || err.code === 'PAUSED')) break;
      }
    }
    return summary;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async poll(act: any, videoId: string, now: Date, pollSeconds: number): Promise<number> {
    let liveChatId: string | null = act.liveChatId;
    if (!liveChatId) {
      liveChatId = await this.deps.chat.getActiveLiveChatId(videoId);
      if (!liveChatId) {
        await ChatActivityModel.updateOne({ _id: act._id }, { $set: { status: 'UNAVAILABLE', lastError: 'This stream has no live chat', lastPolledAt: now } });
        return 0;
      }
    }
    const page = await this.deps.chat.listChatMessages(liveChatId, act.pageToken);
    const counts: number[] = [...(act.counts ?? [])];
    const bucketMs = (act.bucketSeconds ?? CHAT_BUCKET_SECONDS) * 1000;
    const anchor = new Date(act.anchorAt).getTime();
    let added = 0;
    for (const t of page.messageTimes) {
      const i = Math.floor((t.getTime() - anchor) / bucketMs);
      if (i < 0 || i > 200_000) continue;
      while (counts.length <= i) counts.push(0);
      counts[i] = (counts[i] ?? 0) + 1;
      added++;
    }
    const waitMs = Math.max(pollSeconds * 1000, page.pollingIntervalMs);
    await ChatActivityModel.updateOne(
      { _id: act._id },
      {
        $set: {
          liveChatId,
          pageToken: page.nextPageToken ?? act.pageToken,
          counts,
          lastPolledAt: now,
          lastError: null,
          nextPollAt: new Date(now.getTime() + waitMs),
          ...(page.ended ? { status: 'ENDED' } : {}),
        },
        $inc: { messageCount: added },
      },
    );
    return added;
  }
}

/** Chat counts for analysis, or [] when too little chat was captured to mean anything. */
export async function loadChatCounts(sessionId: string, minMessages = 50): Promise<number[]> {
  const act = await ChatActivityModel.findOne({ liveSessionId: sessionId }).select('counts messageCount').lean();
  return act && act.messageCount >= minMessages ? (act.counts as number[]) : [];
}
