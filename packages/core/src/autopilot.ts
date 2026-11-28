import { AutopilotEventModel, AutopilotStateModel, GeneratedClipModel, LiveSessionModel, StreamerChannelModel, mongoose } from '@shorts/database';
import type { Logger } from '@shorts/observability';
import { ApprovalStatus, PublishingMode, RenderStatus, UploadStatus } from '@shorts/shared-types';
import type { SettingsService } from './settings';

/** Upload failures of auto-approved Shorts in a row before autopilot pauses itself. */
export const PAUSE_AFTER_FAILURES = 3;
/** A finished Short may run a little over the clip limit (cold open, rounding). */
const LENGTH_SLACK_SECONDS = 5;
/** Two Shorts sharing more than this part of the shorter one count as the same moment. */
const DUPLICATE_OVERLAP = 0.5;

/** Words that make a title risky for ads or community guidelines: held for a person to check. */
const RISKY_TITLE = /\b(f+u+c+k\w*|sh[i1]t(s|ty|ting)?|b[i1]tch(es|y)?|n[i1]gg\w*|f[a@]gg?(s|ot|ots)?|rap(e|ed|es|ing)|k[i1]ll (him|her|them|yourself)|suicide|porn\w*|nudes?|sex(y|ual)?)\b/i;

export interface GateInput {
  score: number | null;
  durationSeconds: number;
  title: string;
  minScore: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  /** Share of this Short already covered by another uploaded Short (0–1). */
  duplicateOverlap: number;
  /** The session's language when it differs from the channel language, else null. */
  languageMismatch: string | null;
}

/** The quality gate: every reason a Short must wait for a person. Empty = publish. */
export function qualityGate(g: GateInput): string[] {
  const reasons: string[] = [];
  const score = g.score ?? 0;
  if (score < g.minScore) reasons.push(`score ${Math.round(score)} < ${g.minScore}`);
  if (g.durationSeconds < Math.min(g.minDurationSeconds, 10)) reasons.push(`too short (${Math.round(g.durationSeconds)} s)`);
  if (g.durationSeconds > g.maxDurationSeconds + LENGTH_SLACK_SECONDS) reasons.push(`too long (${Math.round(g.durationSeconds)} s > ${g.maxDurationSeconds} s)`);
  if (g.duplicateOverlap > DUPLICATE_OVERLAP) reasons.push(`same moment as a Short already posted (${Math.round(g.duplicateOverlap * 100)}% overlap)`);
  if (g.languageMismatch) reasons.push(`language "${g.languageMismatch}" isn't the channel language`);
  if (!g.title.trim()) reasons.push('no title');
  else if (RISKY_TITLE.test(g.title)) reasons.push('title has words that can limit ads; check it');
  return reasons;
}

/** Share of range `a` covered by `b`, relative to the shorter of the two. */
export function overlapShare(a: { startSeconds: number; endSeconds: number }, b: { startSeconds: number; endSeconds: number }): number {
  const inter = Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds);
  const shorter = Math.min(a.endSeconds - a.startSeconds, b.endSeconds - b.startSeconds);
  return inter > 0 && shorter > 0 ? inter / shorter : 0;
}

export interface AutopilotStatusDTO {
  /** Autopilot switched on in Settings (some streamers may still be set to OFF or ON). */
  enabled: boolean;
  paused: boolean;
  pausedReason: string | null;
  pausedAt: string | null;
  consecutiveFailures: number;
  minScore: number;
  today: { published: number; held: number };
}

export interface AutopilotEventDTO {
  id: string;
  kind: 'PUBLISHED' | 'HELD' | 'PAUSED' | 'RESUMED';
  clipId: string | null;
  liveSessionId: string | null;
  title: string;
  score: number | null;
  reasons: string[];
  by: string;
  createdAt: string;
}

interface Notify {
  send(text: string, onceKey?: string): Promise<void>;
}

/**
 * Phase 9 Autopilot: decides which rendered Shorts are published without a
 * click, records why, and pauses itself when uploads keep failing.
 */
export class AutopilotService {
  constructor(
    private readonly deps: {
      settings: SettingsService;
      logger?: Logger;
      notify?: Notify;
      /** Web app origin, for links in alerts. */
      webOrigin?: string;
      languageMismatch?: (sessionId: string, focus: string) => Promise<string | null>;
    },
  ) {}

  private async state() {
    return (await AutopilotStateModel.findById('main').lean()) ?? { paused: false, pausedReason: null, pausedAt: null, consecutiveFailures: 0 };
  }

  /** Is autopilot in charge of this session's streamer right now? */
  async activeFor(sessionId: string): Promise<boolean> {
    if ((await this.state()).paused) return false;
    const { publishing } = (await this.deps.settings.getValues()).values;
    const session = await LiveSessionModel.findById(sessionId).select('streamerChannelId').lean();
    const streamer = session ? await StreamerChannelModel.findById(session.streamerChannelId).select('preferences').lean() : null;
    const override = (streamer?.preferences as { autopilot?: string | null } | undefined)?.autopilot;
    if (override === 'ON') return true;
    if (override === 'OFF') return false;
    return publishing.mode === PublishingMode.AUTO_PUBLISH;
  }

  /**
   * Gate every rendered, titled, not-yet-decided Short of the session.
   * Passing Shorts are approved via `approve`; the rest stay for review.
   */
  async run(sessionId: string, approve: (clipId: string) => Promise<void>): Promise<{ published: number; held: number }> {
    if (!(await this.activeFor(sessionId))) return { published: 0, held: 0 };
    const { publishing, clips: clipSettings } = (await this.deps.settings.getValues()).values;
    const pending = await GeneratedClipModel.find({
      liveSessionId: sessionId,
      renderStatus: RenderStatus.RENDERED,
      approvalStatus: ApprovalStatus.PENDING,
      uploadStatus: UploadStatus.NOT_UPLOADED,
      title: { $ne: '' },
    }).lean();
    if (!pending.length) return { published: 0, held: 0 };
    const posted = await GeneratedClipModel.find({ liveSessionId: sessionId, uploadStatus: { $ne: UploadStatus.NOT_UPLOADED } })
      .select('startSeconds endSeconds')
      .lean();
    const language = this.deps.languageMismatch ? await this.deps.languageMismatch(sessionId, publishing.focusLanguage) : null;
    const decided = await AutopilotEventModel.distinct('clipId', { clipId: { $in: pending.map((c) => c._id) } });
    const seen = new Set(decided.map(String));

    let published = 0;
    let held = 0;
    for (const c of pending) {
      if (seen.has(String(c._id))) continue; // held before: a person decides now
      const reasons = qualityGate({
        score: c.highlightScore ?? null,
        durationSeconds: c.durationSeconds ?? 0,
        title: c.title ?? '',
        minScore: publishing.autopilotMinScore ?? 75,
        minDurationSeconds: clipSettings.minDurationSeconds,
        maxDurationSeconds: clipSettings.maxDurationSeconds,
        duplicateOverlap: Math.max(0, ...posted.map((p) => overlapShare(c, p))),
        languageMismatch: language,
      });
      if (!reasons.length) {
        try {
          await approve(String(c._id));
          posted.push(c);
          published++;
          await this.log('PUBLISHED', c, [`score ${Math.round(c.highlightScore ?? 0)} ≥ ${publishing.autopilotMinScore ?? 75}`]);
          await this.deps.notify?.send(
            `🤖 Autopilot is publishing: ${c.title}\nScore ${Math.round(c.highlightScore ?? 0)}. Unpublish or edit: ${this.link(`/clips?session=${sessionId}&stage=PUBLISHED`)}\nPause autopilot: ${this.link('/autopilot')}`,
          );
          continue;
        } catch (err) {
          reasons.push(`could not approve: ${(err as Error).message}`);
        }
      }
      held++;
      await this.log('HELD', c, reasons);
    }
    if (held) {
      await this.deps.notify?.send(`✋ Autopilot held ${held} Short${held === 1 ? '' : 's'} for review\n${this.link(`/clips?session=${sessionId}&stage=READY`)}`);
    }
    this.deps.logger?.info({ sessionId, published, held }, 'Autopilot decisions');
    return { published, held };
  }

  async pause(reason: string, by = 'autopilot'): Promise<void> {
    const res = await AutopilotStateModel.updateOne(
      { _id: 'main', paused: { $ne: true } },
      { $set: { paused: true, pausedReason: reason, pausedAt: new Date() } },
      { upsert: true },
    ).catch((err: { code?: number }) => (err.code === 11000 ? { modifiedCount: 0, upsertedCount: 0 } : Promise.reject(err)));
    if (!res.modifiedCount && !res.upsertedCount) return; // already paused
    await AutopilotEventModel.create({ kind: 'PAUSED', reasons: [reason], by });
    await this.deps.notify?.send(`⏸ Autopilot paused: ${reason}\nNew Shorts wait for review until you resume: ${this.link('/autopilot')}`);
    this.deps.logger?.warn({ reason, by }, 'Autopilot paused');
  }

  async resume(by: string): Promise<void> {
    await AutopilotStateModel.updateOne({ _id: 'main' }, { $set: { paused: false, pausedReason: null, pausedAt: null, consecutiveFailures: 0 } }, { upsert: true });
    await AutopilotEventModel.create({ kind: 'RESUMED', by });
  }

  /** Called when an upload finally fails. Only auto-approved Shorts count toward the pause. */
  async uploadFailed(clipId: string, message: string): Promise<void> {
    const clip = await GeneratedClipModel.findById(clipId).select('approvalStatus').lean();
    if (/reconnect/i.test(message)) return this.pause('the YouTube connection needs to be renewed (Settings → YouTube → Reconnect)');
    if (clip?.approvalStatus !== ApprovalStatus.AUTO_APPROVED) return;
    const s = await AutopilotStateModel.findOneAndUpdate({ _id: 'main' }, { $inc: { consecutiveFailures: 1 } }, { upsert: true, new: true }).lean();
    if ((s?.consecutiveFailures ?? 0) >= PAUSE_AFTER_FAILURES) await this.pause(`${s!.consecutiveFailures} uploads failed in a row. Last error: ${message.slice(0, 200)}`);
  }

  async uploadSucceeded(): Promise<void> {
    await AutopilotStateModel.updateOne({ _id: 'main', consecutiveFailures: { $gt: 0 } }, { $set: { consecutiveFailures: 0 } });
  }

  async status(now = new Date()): Promise<AutopilotStatusDTO> {
    const s = await this.state();
    const { publishing } = (await this.deps.settings.getValues()).values;
    const since = new Date(now.getTime() - 86_400_000);
    const [published, held] = await Promise.all([
      AutopilotEventModel.countDocuments({ kind: 'PUBLISHED', createdAt: { $gte: since } }),
      AutopilotEventModel.countDocuments({ kind: 'HELD', createdAt: { $gte: since } }),
    ]);
    return {
      enabled: publishing.mode === PublishingMode.AUTO_PUBLISH,
      paused: Boolean(s.paused),
      pausedReason: s.pausedReason ?? null,
      pausedAt: s.pausedAt ? new Date(s.pausedAt).toISOString() : null,
      consecutiveFailures: s.consecutiveFailures ?? 0,
      minScore: publishing.autopilotMinScore ?? 75,
      today: { published, held },
    };
  }

  async events(limit = 100): Promise<AutopilotEventDTO[]> {
    const rows = await AutopilotEventModel.find().sort({ createdAt: -1 }).limit(Math.min(500, limit)).lean();
    return rows.map((r) => ({
      id: String(r._id),
      kind: r.kind as AutopilotEventDTO['kind'],
      clipId: r.clipId ? String(r.clipId) : null,
      liveSessionId: r.liveSessionId ? String(r.liveSessionId) : null,
      title: r.title ?? '',
      score: r.score ?? null,
      reasons: r.reasons ?? [],
      by: r.by ?? 'autopilot',
      createdAt: (r as { createdAt?: Date }).createdAt?.toISOString() ?? '',
    }));
  }

  private log(kind: 'PUBLISHED' | 'HELD', c: { _id: mongoose.Types.ObjectId; liveSessionId?: unknown; title?: string | null; highlightScore?: number | null }, reasons: string[]) {
    return AutopilotEventModel.create({ kind, clipId: c._id, liveSessionId: c.liveSessionId ?? null, title: c.title ?? '', score: c.highlightScore ?? null, reasons });
  }

  private link(path: string) {
    return `${this.deps.webOrigin ?? ''}${path}`;
  }
}
