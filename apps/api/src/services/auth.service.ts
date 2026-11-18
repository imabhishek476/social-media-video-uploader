import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UserModel } from '@shorts/database';
import { UserRole, type UserDTO } from '@shorts/shared-types';
import type { AppConfig } from '@shorts/config';
import { AppError, ErrorCode } from '../errors';

export const SESSION_COOKIE = 'shorts_session';
const BCRYPT_ROUNDS = 12;
// Constant-time-ish: compare against a dummy hash when the user doesn't exist
// so response timing doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', BCRYPT_ROUNDS);

interface TokenPayload {
  sub: string;
  role: UserRole;
}

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);

export function toUserDTO(user: {
  _id: unknown;
  email: string;
  name: string;
  role: string;
  lastLoginAt?: Date | null;
}): UserDTO {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

export class AuthService {
  constructor(private readonly config: AppConfig) {}

  async verifyCredentials(email: string, password: string): Promise<UserDTO> {
    const user = await UserModel.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled) {
      throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password');
    }
    user.lastLoginAt = new Date();
    await user.save();
    return toUserDTO(user);
  }

  issueToken(user: UserDTO): string {
    const payload: TokenPayload = { sub: user.id, role: user.role };
    return jwt.sign(payload, this.config.auth.jwtSecret, {
      expiresIn: Math.round(this.config.auth.jwtExpiresInHours * 3600),
      issuer: 'ai-shorts-api',
    });
  }

  /** Verify the token and re-load the user so disabled/deleted users lose access immediately. */
  async resolveToken(token: string): Promise<Express.AuthenticatedUser> {
    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, this.config.auth.jwtSecret, { issuer: 'ai-shorts-api' }) as unknown as TokenPayload;
    } catch {
      throw AppError.unauthenticated('Session expired or invalid');
    }
    const user = await UserModel.findById(payload.sub).lean();
    if (!user || user.disabled) throw AppError.unauthenticated('Session expired or invalid');
    return { id: String(user._id), email: user.email, name: user.name, role: user.role as UserRole };
  }

  cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'strict' as const,
      path: '/',
      maxAge: Math.round(this.config.auth.jwtExpiresInHours * 3600 * 1000),
    };
  }
}

/**
 * Create the admin from ADMIN_EMAIL / ADMIN_PASSWORD if no user with that
 * email exists. Existing users are never modified.
 */
export async function ensureBootstrapAdmin(
  config: AppConfig,
  logger: { info: (o: object, m: string) => void },
): Promise<'created' | 'exists' | 'skipped'> {
  if (!config.bootstrapAdmin) return 'skipped';
  const { email, password } = config.bootstrapAdmin;
  if (password.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters');
  const existing = await UserModel.exists({ email: email.toLowerCase() });
  if (existing) return 'exists';
  await UserModel.create({
    email,
    name: 'Administrator',
    role: UserRole.ADMIN,
    passwordHash: await hashPassword(password),
  });
  logger.info({ email }, 'Bootstrap admin user created');
  return 'created';
}
