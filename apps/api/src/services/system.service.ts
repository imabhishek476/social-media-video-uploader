import { pingDatabase } from '@shorts/database';
import { listHeartbeats, pingRedis } from '@shorts/queue';
import type { DependencyCheck, ReadyDTO, SystemStatusDTO } from '@shorts/shared-types';
import type { AppDeps } from '../context';

async function check(fn: () => Promise<number>, expose: boolean): Promise<DependencyCheck> {
  try {
    return { ok: true, latencyMs: await withTimeout(fn(), 3_000) };
  } catch (err) {
    return { ok: false, error: expose ? (err as Error).message : 'unavailable' };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export async function getReadiness(deps: AppDeps): Promise<ReadyDTO> {
  const expose = !deps.config.isProduction;
  const [mongo, redis] = await Promise.all([check(pingDatabase, expose), check(() => pingRedis(deps.redis), expose)]);
  return { status: mongo.ok && redis.ok ? 'ready' : 'not_ready', checks: { mongo, redis } };
}

export async function getSystemStatus(deps: AppDeps): Promise<SystemStatusDTO> {
  const ready = await getReadiness(deps);
  if (!ready.checks.redis.ok) return { ready, workers: [], queues: [], youtube: null };
  const yt = deps.config.integrations.youtube;
  const [workers, queues, quotaUsedToday, pausedUntil] = await Promise.all([
    listHeartbeats(deps.redis),
    deps.queues.counts(),
    deps.youtube.quota.usedToday(),
    deps.youtube.quota.pausedUntil(),
  ]);
  return {
    ready,
    workers,
    queues,
    youtube: {
      provider: deps.youtube.provider.name,
      liveDetection: yt.liveDetection,
      quotaUsedToday,
      dailyQuota: yt.dailyQuota,
      pausedUntil: pausedUntil ? pausedUntil.toISOString() : null,
    },
  };
}
