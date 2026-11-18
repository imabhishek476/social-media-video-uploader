import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanTempDir } from '../src/processors/cleanup';

describe('cleanTempDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-cleanup-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('deletes only files older than the cutoff, including nested ones', async () => {
    const old = path.join(dir, 'old.mp4');
    const nestedOld = path.join(dir, 'job-1', 'chunk.wav');
    const fresh = path.join(dir, 'fresh.mp4');
    await fs.mkdir(path.dirname(nestedOld), { recursive: true });
    await Promise.all([fs.writeFile(old, 'aaaa'), fs.writeFile(nestedOld, 'bb'), fs.writeFile(fresh, 'c')]);
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
    await fs.utimes(old, twoDaysAgo, twoDaysAgo);
    await fs.utimes(nestedOld, twoDaysAgo, twoDaysAgo);

    const result = await cleanTempDir(dir, 24);

    expect(result).toEqual({ scanned: 3, deleted: 2, freedBytes: 6 });
    await expect(fs.access(fresh)).resolves.toBeUndefined();
    await expect(fs.access(old)).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'job-1'))).resolves.toBeUndefined();
  });

  it('treats a missing directory as empty', async () => {
    await expect(cleanTempDir(path.join(dir, 'nope'), 1)).resolves.toEqual({ scanned: 0, deleted: 0, freedBytes: 0 });
  });
});
