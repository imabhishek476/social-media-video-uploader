import type { UserRole } from '@shorts/shared-types';

declare global {
  namespace Express {
    interface AuthenticatedUser {
      id: string;
      email: string;
      name: string;
      role: UserRole;
    }
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
