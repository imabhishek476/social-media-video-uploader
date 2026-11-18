import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Paths that must never reach log output (spec §16: never log tokens/secrets).
 * Applied to every logger, including request/response serialisation.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  '*.passwordHash',
  'token',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  '*.clientSecret',
];

export interface CreateLoggerOptions {
  service: string;
  level?: LoggerOptions['level'];
  pretty?: boolean;
}

export function createLogger({ service, level = 'info', pretty = false }: CreateLoggerOptions): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  });
}

/**
 * Correlation fields used across API and workers so one stream's journey can
 * be traced end to end (spec §16).
 */
export interface CorrelationFields {
  requestId?: string;
  jobId?: string;
  channelId?: string;
  liveSessionId?: string;
  clipId?: string;
}

export const withCorrelation = (logger: Logger, fields: CorrelationFields): Logger => logger.child(fields);
