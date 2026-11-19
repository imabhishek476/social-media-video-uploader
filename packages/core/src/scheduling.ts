import { LiveSessionModel } from '@shorts/database';
import type { SettingsService } from './settings';

/** Hour of day (0–23) and minute of `date` in `timeZone`. */
export function localHour(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h + m / 60;
}

/**
 * Publish window (spec §15 "smart scheduling"): when `now` is outside
 * [startHour, endHour) in `timeZone`, the next moment it opens; otherwise null.
 * Steps in 5-minute increments so DST and odd offsets (e.g. +05:30) just work.
 */
export function nextWindowOpen(now: Date, startHour: number, endHour: number, timeZone: string): Date | null {
  if (startHour <= 0 && endHour >= 24) return null;
  const inside = (d: Date) => {
    const h = localHour(d, timeZone);
    return h >= startHour && h < endHour;
  };
  if (inside(now)) return null;
  const step = 5 * 60_000;
  let t = Math.ceil(now.getTime() / step) * step;
  for (let i = 0; i < (48 * 60) / 5; i++, t += step) {
    if (inside(new Date(t))) return new Date(t);
  }
  return null;
}

/** First moment of next month (UTC). */
export const startOfNextMonthUtc = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
const startOfMonthUtc = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Estimated AI spend (transcription + LLM) of sessions created this month (UTC). */
export async function monthToDateSpendUsd(now = new Date()): Promise<number> {
  const [r] = await LiveSessionModel.aggregate<{ total: number }>([
    { $match: { createdAt: { $gte: startOfMonthUtc(now) } } },
    { $group: { _id: null, total: { $sum: '$estimatedCostUsd' } } },
  ]);
  return Math.round((r?.total ?? 0) * 10000) / 10000;
}

export interface BudgetStatus {
  budgetUsd: number;
  spentUsd: number;
  exceeded: boolean;
  resumesAt: Date | null;
}

/** Cost control (spec §17): paid AI steps pause once the monthly budget is used up. */
export async function budgetStatus(settings: SettingsService, now = new Date()): Promise<BudgetStatus> {
  const { costs } = (await settings.getValues()).values;
  const spentUsd = await monthToDateSpendUsd(now);
  const exceeded = costs.monthlyBudgetUsd > 0 && spentUsd >= costs.monthlyBudgetUsd;
  return { budgetUsd: costs.monthlyBudgetUsd, spentUsd, exceeded, resumesAt: exceeded ? startOfNextMonthUtc(now) : null };
}
