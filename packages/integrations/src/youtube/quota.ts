import type { Redis } from '@shorts/queue';

/**
 * Tracks YouTube Data API quota units per day (quota resets at midnight
 * Pacific time) and supports a temporary pause after a quota error, so every
 * API/worker process shares one view of consumption (spec §18 "API quota
 * consumption").
 */
export interface QuotaTracker {
  record(units: number): Promise<void>;
  usedToday(): Promise<number>;
  pause(ms: number): Promise<void>;
  pausedUntil(): Promise<Date | null>;
}

const PREFIX = 'shorts:youtube:quota:';
const PAUSE_KEY = 'shorts:youtube:paused-until';

/** YYYY-MM-DD in America/Los_Angeles. */
export function pacificDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function createRedisQuotaTracker(redis: Redis): QuotaTracker {
  return {
    async record(units) {
      if (units <= 0) return;
      const key = PREFIX + pacificDay();
      await redis.multi().incrby(key, units).expire(key, 3 * 24 * 3600).exec();
    },
    async usedToday() {
      return Number((await redis.get(PREFIX + pacificDay())) ?? 0);
    },
    async pause(ms) {
      const until = Date.now() + ms;
      await redis.set(PAUSE_KEY, String(until), 'PX', ms);
    },
    async pausedUntil() {
      const v = await redis.get(PAUSE_KEY);
      return v && Number(v) > Date.now() ? new Date(Number(v)) : null;
    },
  };
}

/** In-memory tracker for tests and scripts. */
export function createMemoryQuotaTracker(): QuotaTracker & { reset(): void } {
  let used = 0;
  let pausedUntil = 0;
  return {
    async record(units) {
      used += units;
    },
    async usedToday() {
      return used;
    },
    async pause(ms) {
      pausedUntil = Date.now() + ms;
    },
    async pausedUntil() {
      return pausedUntil > Date.now() ? new Date(pausedUntil) : null;
    },
    reset() {
      used = 0;
      pausedUntil = 0;
    },
  };
}
