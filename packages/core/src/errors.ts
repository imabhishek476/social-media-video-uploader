/**
 * Business-rule failure raised by domain services. Transport-agnostic: the
 * API maps `httpStatus`/`code` onto its JSON error body; workers log it.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  static notFound(what: string) {
    return new DomainError('NOT_FOUND', `${what} not found`, 404);
  }
}

export const isDuplicateKeyError = (err: unknown) => (err as { code?: number })?.code === 11000;
