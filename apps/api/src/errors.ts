import type { ZodError, ZodType, ZodTypeDef } from 'zod';

/** Structured error codes surfaced to clients and logs (spec §13, §16). */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, ErrorCode.VALIDATION_FAILED, message, details);
  }
  static unauthenticated(message = 'Authentication required') {
    return new AppError(401, ErrorCode.UNAUTHENTICATED, message);
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError(403, ErrorCode.FORBIDDEN, message);
  }
  static notFound(message = 'Resource not found') {
    return new AppError(404, ErrorCode.NOT_FOUND, message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, ErrorCode.CONFLICT, message, details);
  }
}

export const formatZodIssues = (error: ZodError) =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/** Parse untrusted input or throw a 400 with field-level details. */
export function parseOrThrow<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw AppError.badRequest('Request validation failed', formatZodIssues(result.error));
  return result.data;
}
