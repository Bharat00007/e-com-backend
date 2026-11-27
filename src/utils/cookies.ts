import { CookieOptions } from 'express';
import { env } from '../config/env';

/** Returns consistent HTTP-only cookie attributes across auth and guest cart routes. */
export function buildCookieOptions(maxAge?: number): CookieOptions {
  const isVercel = process.env.VERCEL === '1';
  const isProd = env.NODE_ENV === 'production' || isVercel;
  const sameSite = env.COOKIE_SAME_SITE ?? (isProd ? 'none' : 'none');
  const secure = true;

  const validDomain =
    env.COOKIE_DOMAIN &&
    env.COOKIE_DOMAIN !== 'localhost' &&
    !env.COOKIE_DOMAIN.includes('localhost')
      ? env.COOKIE_DOMAIN
      : undefined;

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    ...(validDomain ? { domain: validDomain } : {}),
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}
