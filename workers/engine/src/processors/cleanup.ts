import fs from 'node:fs/promises';
import path from 'node:path';
import type { TrackedHandler, TrackedJobData } from '../tracked-job';

export interface CleanupJobData extends TrackedJobData {
  tempDir: string;
  maxAgeHours: number;
}

export interface CleanupResult {
  scanned: number;
  deleted: number;
  freedBytes: number;
}

/**
 * Delete temporary processing files older than `maxAgeHours` (spec §19).
 * Only ever touches files inside `tempDir`; directories are left in place.
 */
export async function cleanTempDir(tempDir: string, maxAgeHours: number, now = Date.now()): Promise<CleanupResult> {
  const root = path.resolve(tempDir);
  const cutoff = now - maxAgeHours * 3600 * 1000;
  const result: CleanupResult = { scanned: 0, deleted: 0, freedBytes: 0 };

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!full.startsWith(root + path.sep)) continue; // never escape the temp root
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        result.scanned++;
        const stat = await fs.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.rm(full, { force: true });
          result.deleted++;
          result.freedBytes += stat.size;
        }
      }
    }
  }

  await walk(root);
  return result;
}

export const cleanupProcessor: TrackedHandler<CleanupJobData, CleanupResult> = async (data, { logger }) => {
  const result = await cleanTempDir(data.tempDir, data.maxAgeHours);
  logger.info(result, 'Temp cleanup finished');
  return result;
};
