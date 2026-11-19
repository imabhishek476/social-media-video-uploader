// Manual check: npx tsx packages/integrations/test/gcs-smoke.ts   (uses .env)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '@shorts/config';
import { createObjectStorage } from '../src';

const config = loadConfig();
const storage = createObjectStorage(config);
const key = `smoke-test/${Date.now()}.txt`;
const tmp = path.join(os.tmpdir(), 'gcs-smoke.txt');
await fs.writeFile(tmp, 'hello from ai-shorts');
console.log('provider:', storage.name);
console.log('upload:', await storage.upload(key, tmp, 'text/plain'));
console.log('exists:', await storage.exists(key));
await storage.download(key, tmp + '.back');
console.log('roundtrip ok:', (await fs.readFile(tmp + '.back', 'utf8')) === 'hello from ai-shorts');
console.log('signed url ok:', (await storage.signedReadUrl(key, 60)).startsWith('https://'));
await storage.delete(key);
console.log('deleted, exists now:', await storage.exists(key));
