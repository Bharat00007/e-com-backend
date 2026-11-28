import { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { isOriginAllowed } from '../utils/origins';
import {
  computePreAuthCsrfToken,
  computeSessionCsrfToken,
  timingSafeTokenEqual,
  validateCustomerSession,
  validateGuestSession,
} from '../services/sessionService';
import {
  CSRF_NONCE_COOKIE,
  CUSTOMER_SESSION_COOKIE,
  GUEST_SESSION_COOKIE,
} from '../utils/cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function extractRefererOrigin(referer?: string): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * Enforces Origin/Referer checks and synchronizer CSRF tokens on state-changing routes.
 * Cookie-authenticated requests must present an `x-csrf-token` header matching the
 * server-managed PostgreSQL session secret (CustomerSession, GuestSession, or pre-auth nonce).
 */
export async function csrfProtection(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  // Razorpay webhooks are verified using HMAC-SHA256 webhook signature rather than browser cookies
  if (req.path === '/payments/webhook' || req.originalUrl.endsWith('/payments/webhook')) {
    next();
    return;
  }

  // 1. Validate Origin / Referer against exact allowed origins
  const originHeader = req.headers.origin;
  const refererOrigin = extractRefererOrigin(req.headers.referer);
  const requestOrigin = originHeader || refererOrigin;

  if (requestOrigin && !isOriginAllowed(requestOrigin)) {
    next(new AppError('Cross-site request origin denied', 403, 'CSRF_ORIGIN_DENIED'));
    return;
  }

  // 2. Enforce CSRF token verification when browser session cookies are present
  const sidCookie = req.cookies?.[CUSTOMER_SESSION_COOKIE] as string | undefined;
  const gsidCookie = req.cookies?.[GUEST_SESSION_COOKIE] as string | undefined;
  const legacyCookie = (req.cookies?.accessToken || req.cookies?.guestCartToken) as string | undefined;
  const csrfNonceCookie = req.cookies?.[CSRF_NONCE_COOKIE] as string | undefined;

  const hasCookieCredential = Boolean(sidCookie || gsidCookie || legacyCookie);
  if (!hasCookieCredential) {
    next();
    return;
  }

  const providedCsrf = (req.headers['x-csrf-token'] as string | undefined)?.trim();
  if (!providedCsrf) {
    next(new AppError('CSRF security token required for state-changing request', 403, 'CSRF_TOKEN_INVALID'));
    return;
  }

  if (sidCookie) {
    const validated = req.customerSession && req.customer
      ? { session: req.customerSession, customer: req.customer }
      : await validateCustomerSession(sidCookie);
    if (validated) {
      const expected = computeSessionCsrfToken(validated.session.id, validated.session.csrfSecret);
      if (timingSafeTokenEqual(providedCsrf, expected)) {
        if (!req.customer) req.customer = validated.customer;
        if (!req.customerSession) req.customerSession = validated.session;
        next();
        return;
      }
      next(new AppError('Invalid CSRF security token for session', 403, 'CSRF_TOKEN_INVALID'));
      return;
    }
  }

  if (gsidCookie) {
    const guestSession = req.guestSession ?? (await validateGuestSession(gsidCookie));
    if (guestSession) {
      const expected = computeSessionCsrfToken(guestSession.id, guestSession.csrfSecret);
      if (timingSafeTokenEqual(providedCsrf, expected)) {
        if (!req.guestSession) {
          req.guestSession = { id: guestSession.id, csrfSecret: guestSession.csrfSecret };
        }
        next();
        return;
      }
      next(new AppError('Invalid CSRF security token for guest session', 403, 'CSRF_TOKEN_INVALID'));
      return;
    }
  }

  if (csrfNonceCookie) {
    const expected = computePreAuthCsrfToken(csrfNonceCookie);
    if (timingSafeTokenEqual(providedCsrf, expected)) {
      next();
      return;
    }
  }

  next(new AppError('CSRF security token validation failed', 403, 'CSRF_TOKEN_INVALID'));
}
