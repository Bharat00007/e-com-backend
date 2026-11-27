import crypto from 'crypto';
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { hashToken } from '../utils/jwt';
import {
  buildCookieOptions,
  clearGuestSessionCookies,
  CSRF_NONCE_COOKIE,
  CUSTOMER_SESSION_COOKIE,
  GUEST_SESSION_COOKIE,
} from '../utils/cookies';

const CUSTOMER_SESSION_DEFAULT_MS = 24 * 60 * 60 * 1000;
const CUSTOMER_SESSION_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const GUEST_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVITY_TOUCH_THROTTLE_MS = 60 * 1000;

function extractClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'] as string | undefined;
  if (forwarded) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }
  return req.ip ? req.ip.slice(0, 64) : null;
}

function extractUserAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 255) : null;
}

export function computeSessionCsrfToken(sessionId: string, csrfSecret: string): string {
  return crypto
    .createHmac('sha256', env.CSRF_SECRET)
    .update(`${sessionId}:${csrfSecret}`)
    .digest('hex');
}

export function computePreAuthCsrfToken(nonce: string): string {
  return crypto.createHmac('sha256', env.CSRF_SECRET).update(`preauth:${nonce}`).digest('hex');
}

export function timingSafeTokenEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function createCustomerSession(
  req: Request,
  res: Response,
  customerId: string,
  rememberMe = true
) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const csrfSecret = crypto.randomBytes(24).toString('hex');
  const ttlMs = rememberMe ? CUSTOMER_SESSION_REMEMBER_MS : CUSTOMER_SESSION_DEFAULT_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  const session = await prisma.customerSession.create({
    data: {
      tokenHash: hashToken(rawToken),
      csrfSecret,
      customerId,
      userAgent: extractUserAgent(req),
      ipAddress: extractClientIp(req),
      lastActivityAt: new Date(),
      expiresAt,
    },
  });

  const csrfToken = computeSessionCsrfToken(session.id, session.csrfSecret);
  res.cookie(CUSTOMER_SESSION_COOKIE, rawToken, buildCookieOptions(ttlMs, req));
  res.setHeader('x-csrf-token', csrfToken);
  return { session, rawToken, csrfToken };
}

export async function rotateCustomerSession(
  req: Request,
  res: Response,
  customerId: string,
  oldRawSid?: string,
  rememberMe = true
) {
  if (oldRawSid) {
    await prisma.customerSession
      .updateMany({
        where: { tokenHash: hashToken(oldRawSid), revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => undefined);
  }
  return createCustomerSession(req, res, customerId, rememberMe);
}

export async function validateCustomerSession(rawSid: string) {
  const tokenHash = hashToken(rawSid);
  const now = new Date();
  const session = await prisma.customerSession.findUnique({
    where: { tokenHash },
    include: {
      customer: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          emailVerified: true,
          marketingConsent: true,
          status: true,
        },
      },
    },
  });

  if (!session || session.revokedAt || session.expiresAt <= now) {
    return null;
  }
  if (!session.customer || session.customer.status !== 'ACTIVE') {
    return null;
  }

  // Throttle activity write to avoid hot-row contention on concurrent fetches
  if (now.getTime() - session.lastActivityAt.getTime() > ACTIVITY_TOUCH_THROTTLE_MS) {
    void prisma.customerSession
      .update({
        where: { id: session.id },
        data: { lastActivityAt: now },
      })
      .catch(() => undefined);
  }

  return {
    session: {
      id: session.id,
      csrfSecret: session.csrfSecret,
      expiresAt: session.expiresAt,
    },
    customer: session.customer,
  };
}

export async function revokeCustomerSession(rawSid?: string): Promise<void> {
  if (!rawSid) return;
  await prisma.customerSession.updateMany({
    where: { tokenHash: hashToken(rawSid), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function createGuestSession(req: Request, res: Response) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const csrfSecret = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + GUEST_SESSION_TTL_MS);

  const session = await prisma.guestSession.create({
    data: {
      tokenHash: hashToken(rawToken),
      csrfSecret,
      userAgent: extractUserAgent(req),
      ipAddress: extractClientIp(req),
      lastActivityAt: new Date(),
      expiresAt,
    },
  });

  const csrfToken = computeSessionCsrfToken(session.id, session.csrfSecret);
  res.cookie(GUEST_SESSION_COOKIE, rawToken, buildCookieOptions(GUEST_SESSION_TTL_MS, req));
  res.setHeader('x-csrf-token', csrfToken);
  return { session, rawToken, csrfToken };
}

export async function validateGuestSession(rawGsid?: string) {
  if (!rawGsid) return null;
  const now = new Date();
  const session = await prisma.guestSession.findUnique({
    where: { tokenHash: hashToken(rawGsid) },
  });
  if (!session || session.revokedAt || session.consumedAt || session.expiresAt <= now) {
    return null;
  }

  if (now.getTime() - session.lastActivityAt.getTime() > ACTIVITY_TOUCH_THROTTLE_MS) {
    void prisma.guestSession
      .update({
        where: { id: session.id },
        data: { lastActivityAt: now },
      })
      .catch(() => undefined);
  }

  return session;
}

export function issuePreAuthCsrfCookie(req: Request, res: Response): string {
  const existingNonce = req.cookies?.[CSRF_NONCE_COOKIE] as string | undefined;
  const nonce = existingNonce && existingNonce.length >= 16 ? existingNonce : crypto.randomBytes(24).toString('hex');
  if (!existingNonce || existingNonce !== nonce) {
    res.cookie(CSRF_NONCE_COOKIE, nonce, buildCookieOptions(24 * 60 * 60 * 1000, req));
  }
  const token = computePreAuthCsrfToken(nonce);
  res.setHeader('x-csrf-token', token);
  return token;
}

/**
 * Atomically merges one specific GuestSession's active cart into an authenticated customer's cart.
 * Strictly idempotent: claiming GuestSession.consumedAt guarantees repeated calls/retries never double quantities.
 */
export async function mergeGuestSessionCartAtomically(
  guestSessionId: string | undefined,
  customerId: string
): Promise<{ mergedCount: number; customerCartId: string | null }> {
  if (!guestSessionId) {
    const existingCart = await prisma.cart.findUnique({ where: { customerId }, select: { id: true } });
    return { mergedCount: 0, customerCartId: existingCart?.id ?? null };
  }

  return prisma.$transaction(
    async (tx) => {
      const now = new Date();
      // Atomic single-winner claim prevents duplicate merges under concurrent logins/retries
      const claim = await tx.guestSession.updateMany({
        where: {
          id: guestSessionId,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          consumedAt: now,
          consumedByCustomerId: customerId,
        },
      });

      let customerCart = await tx.cart.findUnique({
        where: { customerId },
        include: { items: true },
      });

      if (claim.count !== 1) {
        return { mergedCount: 0, customerCartId: customerCart?.id ?? null };
      }

      const guestCart = await tx.cart.findFirst({
        where: { guestSessionId, status: 'ACTIVE' },
        include: { items: { include: { variant: true } } },
      });

      if (!guestCart || guestCart.items.length === 0) {
        if (guestCart) {
          await tx.cart.update({
            where: { id: guestCart.id },
            data: { status: 'CONSUMED', mergedAt: now },
          });
        }
        return { mergedCount: 0, customerCartId: customerCart?.id ?? null };
      }

      if (!customerCart) {
        customerCart = await tx.cart.create({
          data: { customerId, status: 'ACTIVE', couponCode: guestCart.couponCode },
          include: { items: true },
        });
      } else if (!customerCart.couponCode && guestCart.couponCode) {
        await tx.cart.update({
          where: { id: customerCart.id },
          data: { couponCode: guestCart.couponCode },
        });
      }

      const existingMap = new Map(
        customerCart.items.map((ci) => [`${ci.variantId}:${ci.isSubscription}`, ci])
      );

      let mergedCount = 0;

      for (const item of guestCart.items) {
        if (!item.variant || !item.variant.isAvailable || item.variant.stockQuantity <= 0) {
          continue;
        }
        const key = `${item.variantId}:${item.isSubscription}`;
        const existing = existingMap.get(key);
        const maxStock = item.variant.stockQuantity;

        if (existing) {
          const combinedQty = Math.min(existing.quantity + item.quantity, maxStock);
          await tx.cartItem.update({
            where: { id: existing.id },
            data: { quantity: combinedQty },
          });
          mergedCount += 1;
        } else {
          const cappedQty = Math.min(item.quantity, maxStock);
          const created = await tx.cartItem.create({
            data: {
              cartId: customerCart.id,
              variantId: item.variantId,
              quantity: cappedQty,
              isSubscription: item.isSubscription,
              frequencyWeeks: item.frequencyWeeks,
            },
          });
          existingMap.set(key, created);
          mergedCount += 1;
        }
      }

      await tx.cartItem.deleteMany({ where: { cartId: guestCart.id } });
      await tx.cart.update({
        where: { id: guestCart.id },
        data: {
          status: 'MERGED',
          mergedIntoCartId: customerCart.id,
          mergedAt: now,
        },
      });

      return { mergedCount, customerCartId: customerCart.id };
    },
    { maxWait: 10000, timeout: 25000 }
  );
}

/** Ensures existing guest cart helper clears guest cookie cleanly on login/merge. */
export function clearMergedGuestCookie(res: Response, req?: Request): void {
  clearGuestSessionCookies(res, req);
}
