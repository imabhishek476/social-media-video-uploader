import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, decryptSecret, encryptSecret, parseConfig } from '@shorts/config';
import { idempotencyKey } from '@shorts/queue';
import { settingsUpdateSchema } from '@shorts/shared-types';

describe('config', () => {
  it('applies defaults and falls back to a dev JWT secret outside production', () => {
    const c = parseConfig({ NODE_ENV: 'development' });
    expect(c.port).toBe(8080);
    expect(c.defaults.channelMonitorIntervalSeconds).toBe(300);
    expect(c.auth.usingDevSecret).toBe(true);
    expect(c.worker.roles).toEqual(['all']);
  });

  it('treats blank optional values as unset', () => {
    const c = parseConfig({ YOUTUBE_API_KEY: '  ', ADMIN_EMAIL: 'a@b.c', ADMIN_PASSWORD: '' });
    expect(c.integrations.youtube.apiKey).toBeUndefined();
    expect(c.bootstrapAdmin).toBeUndefined();
  });

  it('requires JWT_SECRET and ENCRYPTION_KEY in production', () => {
    expect(() => parseConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() =>
      parseConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') }),
    ).not.toThrow();
  });

  it('rejects malformed values with a readable message', () => {
    expect(() => parseConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => parseConfig({ ENCRYPTION_KEY: 'short' })).toThrow(/ENCRYPTION_KEY/);
  });
});

describe('secret encryption', () => {
  const key = crypto.randomBytes(32).toString('hex');

  it('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('refresh-token-value', key);
    const b = encryptSecret('refresh-token-value', key);
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh-token-value');
    expect(decryptSecret(a, key)).toBe('refresh-token-value');
  });

  it('detects tampering and wrong keys', () => {
    const payload = encryptSecret('secret', key);
    const parts = payload.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'), key)).toThrow();
    expect(() => decryptSecret(payload, crypto.randomBytes(32).toString('hex'))).toThrow();
  });
});

describe('queue idempotency keys', () => {
  it('is stable and free of characters BullMQ rejects', () => {
    const k = idempotencyKey('session', '65f0c0ffee', 'yt:abc/def');
    expect(k).toBe(idempotencyKey('session', '65f0c0ffee', 'yt:abc/def'));
    expect(k).not.toContain(':');
  });
});

describe('settings update schema', () => {
  it('accepts partial sections and rejects unknown sections', () => {
    expect(settingsUpdateSchema.safeParse({ clips: { maxClipsPerStream: 3 } }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ nope: {} }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ subtitles: { highlightColor: 'yellow' } }).success).toBe(false);
  });
});

describe('config blank values', () => {
  it('treats blank env vars as unset and auto-selects the YouTube provider', () => {
    expect(parseConfig({ YOUTUBE_METADATA_PROVIDER: '', YOUTUBE_LIVE_DETECTION: '', PORT: '' }).integrations.youtube).toMatchObject({
      metadataProvider: 'mock',
      liveDetection: 'rss',
    });
    expect(parseConfig({ YOUTUBE_METADATA_PROVIDER: '', YOUTUBE_API_KEY: 'k' }).integrations.youtube.metadataProvider).toBe('youtube');
    expect(() => parseConfig({ YOUTUBE_METADATA_PROVIDER: 'youtube' })).toThrow(/YOUTUBE_API_KEY/);
  });
});

describe('config ports and paths', () => {
  it('prefers API_PORT over a generic PORT and anchors STORAGE_DIR to the base dir', () => {
    const c = parseConfig({ PORT: '5173', API_PORT: '8080', STORAGE_DIR: './storage' }, '/srv/app');
    expect(c.port).toBe(8080);
    expect(c.worker.storageDir).toBe('/srv/app/storage');
    expect(parseConfig({ PORT: '9000' }).port).toBe(9000);
  });
});
