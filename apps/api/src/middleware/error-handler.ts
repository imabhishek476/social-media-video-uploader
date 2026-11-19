import type { ErrorRequestHandler, RequestHandler } from 'express';
import { DomainError } from '@shorts/core';
import type { ApiErrorBody } from '@shorts/shared-types';
import { AppError, ErrorCode } from '../errors';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.path} not found`));
};

/** Centralised error handler: consistent JSON body, no stack traces leaked. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.id ? String(req.id) : undefined;

  let appError: AppError;
  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof DomainError) {
    // Domain codes (e.g. DUPLICATE_CHANNEL) pass through to clients unchanged.
    appError = new AppError(err.httpStatus, err.code as ErrorCode, err.message, err.details);
  } else if (err?.type === 'entity.parse.failed') {
    appError = AppError.badRequest('Malformed JSON body');
  } else if (err?.type === 'entity.too.large') {
    appError = new AppError(413, ErrorCode.VALIDATION_FAILED, 'Request body too large');
  } else {
    appError = new AppError(500, ErrorCode.INTERNAL, 'Internal server error');
  }

  if (appError.status >= 500) req.log?.error({ err }, 'Unhandled error');
  else req.log?.debug({ code: appError.code, msg: appError.message }, 'Request rejected');

  const body: ApiErrorBody = {
    error: { code: appError.code, message: appError.message, details: appError.details, requestId },
  };
  res.status(appError.status).json(body);
};

/**
 * CSRF defence-in-depth on top of SameSite=strict cookies: state-changing
 * requests with a body must be JSON (HTML forms cannot send JSON cross-site
 * without a CORS preflight).
 */
export const requireJsonForMutations: RequestHandler = (req, _res, next) => {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  // Binary uploads must send a custom header: browsers can't attach one to a
  // cross-site form post without a CORS preflight, which our CORS policy denies.
  const isUpload = req.headers['x-upload-filename'] !== undefined;
  if (mutating && hasBody && !isUpload && !req.is('application/json')) {
    throw new AppError(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, 'Content-Type must be application/json');
  }
  next();
};
