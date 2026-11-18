import crypto from 'node:crypto';

/**
 * AES-256-GCM helpers for encrypting sensitive values (e.g. OAuth refresh
 * tokens) before they are written to MongoDB.
 *
 * Format: `v1:<iv b64>:<auth tag b64>:<ciphertext b64>`
 */
const VERSION = 'v1';

function keyFromHex(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (64 hex characters)');
  return key;
}

export function encryptSecret(plaintext: string, hexKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromHex(hexKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(payload: string, hexKey: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error('Unrecognised encrypted payload format');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromHex(hexKey), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
