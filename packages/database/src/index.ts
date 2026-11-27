import mongoose from 'mongoose';

export { mongoose };
export type { Model } from 'mongoose';
export * from './models/user';
export * from './models/streamer-channel';
export * from './models/live-session';
export * from './models/transcript';
export * from './models/highlight-candidate';
export * from './models/generated-clip';
export * from './models/processing-job';
export * from './models/app-settings';
export * from './models/audit-log';
export * from './models/chat-activity';
export * from './models/compilation';

interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export async function connectDatabase(uri: string, logger?: MinimalLogger): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => logger?.warn({}, 'MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger?.info({}, 'MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger?.error({ err }, 'MongoDB connection error'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: true });
  logger?.info({ db: mongoose.connection.name }, 'MongoDB connected');
  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

/** Round-trip ping used by readiness checks. */
export async function pingDatabase(): Promise<number> {
  const started = Date.now();
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) throw new Error('MongoDB not connected');
  await db.admin().ping();
  return Date.now() - started;
}

/** Create/verify every model's indexes (run on startup and in tests). */
export async function syncIndexes(): Promise<void> {
  await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));
}
