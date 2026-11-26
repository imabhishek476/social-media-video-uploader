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

// ---------------------------------------------------------------------------
// Publish slots (scheduled publishing)
// ---------------------------------------------------------------------------

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "12:30, 18:00" → [[12,30],[18,0]], sorted. */
export function parseSlotTimes(text: string): Array<[number, number]> {
  return text
    .split(',')
    .map((t) => t.trim().match(/^(\d{1,2}):(\d{2})$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => [Number(m[1]), Number(m[2])] as [number, number])
    .filter(([h, m]) => h < 24 && m < 60)
    .sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
}

/** "Sat, Sun" → [6, 0]. */
export const parseSkipDays = (text: string): number[] =>
  text
    .split(',')
    .map((d) => DAY_NAMES.indexOf(d.trim().slice(0, 3).toLowerCase()))
    .filter((i) => i >= 0);

/** Calendar date, weekday and minutes-past-midnight of `date` in `timeZone`. */
function localParts(date: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), wd: DAY_NAMES.indexOf(String(p.weekday).toLowerCase().slice(0, 3)) };
}

/** The instant when the clock in `timeZone` shows y-mo-d h:mi. */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(t), timeZone);
    const diff = want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    if (!diff) break;
    t += diff;
  }
  return new Date(t);
}

/** Local calendar day key (YYYY-MM-DD) of `date` in `timeZone`. */
export function localDay(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export interface SlotPlanInput {
  now: Date;
  timeZone: string;
  slots: Array<[number, number]>;
  skipDays: number[];
  /** Slots already given to other Shorts. */
  taken: Date[];
  /** Slots of Shorts from the same stream/video. */
  sameSource: Date[];
  maxPerSourcePerDay: number;
  /** Empty days between posting days (0 = every day). A day that already has posts can take more. */
  dayGap?: number;
  /** Don't pick a slot sooner than this (time to upload and process). */
  minLeadMinutes?: number;
  maxDays?: number;
}

/**
 * The first free publish slot: not taken by another Short, not on a skipped
 * day, at least `minLeadMinutes` away, and with fewer than
 * `maxPerSourcePerDay` Shorts from the same source that day.
 */
export function planSlot(i: SlotPlanInput): Date | null {
  if (!i.slots.length) return null;
  const earliest = i.now.getTime() + (i.minLeadMinutes ?? 20) * 60_000;
  const taken = new Set(i.taken.map((d) => Math.round(d.getTime() / 60_000)));
  const perDay = new Map<string, number>();
  for (const d of i.sameSource) perDay.set(localDay(d, i.timeZone), (perDay.get(localDay(d, i.timeZone)) ?? 0) + 1);
  const dayNumber = (d: Date) => {
    const p = localParts(d, i.timeZone);
    return Date.UTC(p.y, p.mo - 1, p.d) / 86_400_000;
  };
  const postingDays = new Set(i.taken.map(dayNumber));
  const gap = i.dayGap ?? 0;
  const gapOk = (n: number) => postingDays.has(n) || [...postingDays].every((p) => Math.abs(p - n) > gap);
  const today = localParts(i.now, i.timeZone);
  for (let day = 0; day < (i.maxDays ?? 60); day++) {
    // Noon of the local day avoids DST edges when stepping days.
    const noon = zonedTime(today.y, today.mo, today.d + day, 12, 0, i.timeZone);
    const p = localParts(noon, i.timeZone);
    if (i.skipDays.includes(p.wd)) continue;
    if (gap > 0 && !gapOk(dayNumber(noon))) continue;
    if (i.maxPerSourcePerDay > 0 && (perDay.get(localDay(noon, i.timeZone)) ?? 0) >= i.maxPerSourcePerDay) continue;
    for (const [h, m] of i.slots) {
      const at = zonedTime(p.y, p.mo, p.d, h, m, i.timeZone);
      if (at.getTime() < earliest || taken.has(Math.round(at.getTime() / 60_000))) continue;
      return at;
    }
  }
  return null;
}

/**
 * Best hours from this channel's own results: average views by the local
 * hour a Short went public. Needs `minShorts` Shorts overall and 3 per hour;
 * returns `count` hours at least 2 h apart (as slots), or null when there
 * isn't enough data yet.
 */
export function bestHours(published: Array<{ at: Date; views: number }>, timeZone: string, count: number, minShorts = 30): Array<[number, number]> | null {
  if (published.length < minShorts || count < 1) return null;
  const byHour = new Map<number, number[]>();
  for (const s of published) {
    const h = Math.floor(localHour(s.at, timeZone));
    byHour.set(h, [...(byHour.get(h) ?? []), s.views]);
  }
  const ranked = [...byHour.entries()]
    .filter(([, v]) => v.length >= 3)
    .map(([h, v]) => ({ h, avg: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => b.avg - a.avg);
  const chosen: number[] = [];
  for (const r of ranked) {
    if (chosen.every((c) => Math.min(Math.abs(c - r.h), 24 - Math.abs(c - r.h)) >= 2)) chosen.push(r.h);
    if (chosen.length >= count) break;
  }
  if (chosen.length < Math.min(count, 2)) return null;
  return chosen.sort((a, b) => a - b).map((h) => [h, 0]);
}
