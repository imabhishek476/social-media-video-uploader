import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@shorts/shared-types';
import { AppError } from '../errors';
import { SESSION_COOKIE, type AuthService } from '../services/auth.service';

/** Authenticate via the httpOnly session cookie (or a Bearer token for scripts). */
export function requireAuth(auth: AuthService): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token =
      (req.cookies?.[SESSION_COOKIE] as string | undefined) ??
      (header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined);
    if (!token) throw AppError.unauthenticated();
    req.user = await auth.resolveToken(token);
    req.log = req.log.child({ userId: req.user.id });
    next();
  };
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw AppError.unauthenticated();
    if (!roles.includes(req.user.role)) throw AppError.forbidden();
    next();
  };
}
