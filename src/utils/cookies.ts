import { CookieOptions } from 'express';
import { env } from '../config/env';

/** Returns consistent HTTP-only cookie attributes across auth and guest cart routes. */
export function buildCookieOptions(maxAge?: number): CookieOptions {
  const isProd = env.NODE_ENV === 'production';
  const sameSite = env.COOKIE_SAME_SITE ?? 'lax';
  const secure = isProd || sameSite === 'none';

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    ...(env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'localhost'
      ? { domain: env.COOKIE_DOMAIN }
      : {}),
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}
