import { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { verifyAccessToken } from '../utils/jwt';
import { prisma } from '../config/prisma';
import { validateCustomerSession, validateGuestSession } from '../services/sessionService';
import { CUSTOMER_SESSION_COOKIE, GUEST_SESSION_COOKIE } from '../utils/cookies';

function extractBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const headerToken = authHeader.slice(7).trim();
    if (headerToken) return headerToken;
  }
  return undefined;
}

export async function requireCustomerAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  // Fast path if session was already validated by earlier middleware (e.g. CSRF)
  if (req.customer) {
    next();
    return;
  }

  // 1. Primary path: PostgreSQL-backed opaque server session via HttpOnly `sid` cookie
  const sidCookie = req.cookies?.[CUSTOMER_SESSION_COOKIE] as string | undefined;
  if (sidCookie) {
    const validated = await validateCustomerSession(sidCookie);
    if (!validated) {
      throw new UnauthorizedError('Session expired or revoked. Please sign in again.');
    }
    req.customer = {
      id: validated.customer.id,
      email: validated.customer.email,
      fullName: validated.customer.fullName,
      status: validated.customer.status,
    };
    req.customerSession = {
      id: validated.session.id,
      csrfSecret: validated.session.csrfSecret,
    };
    next();
    return;
  }

  // 2. Fallback: Explicit Bearer token (for automated API tests / programmatic Swagger clients)
  const bearerToken = extractBearerToken(req);
  if (bearerToken) {
    try {
      const payload = verifyAccessToken(bearerToken);
      if (payload.type === 'customer') {
        const found = await prisma.customer.findUnique({
          where: { id: payload.sub },
          select: { id: true, email: true, fullName: true, status: true },
        });
        if (found && found.status === 'ACTIVE') {
          req.customer = found;
          next();
          return;
        }
      }
    } catch {
      // Invalid bearer token
    }
  }

  throw new UnauthorizedError('Customer authentication required');
}

export async function optionalCustomerAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  // Fast path if session/guest was already validated by earlier middleware (e.g. CSRF)
  if (req.customer || req.guestSession) {
    next();
    return;
  }

  // 1. Check PostgreSQL CustomerSession (`sid` cookie)
  const sidCookie = req.cookies?.[CUSTOMER_SESSION_COOKIE] as string | undefined;
  if (sidCookie) {
    const validated = await validateCustomerSession(sidCookie);
    if (validated) {
      req.customer = {
        id: validated.customer.id,
        email: validated.customer.email,
        fullName: validated.customer.fullName,
        status: validated.customer.status,
      };
      req.customerSession = {
        id: validated.session.id,
        csrfSecret: validated.session.csrfSecret,
      };
      next();
      return;
    }
  } else {
    // Only consider Bearer token when no customer session cookie is present
    const bearerToken = extractBearerToken(req);
    if (bearerToken) {
      try {
        const payload = verifyAccessToken(bearerToken);
        if (payload.type === 'customer') {
          const found = await prisma.customer.findUnique({
            where: { id: payload.sub },
            select: { id: true, email: true, fullName: true, status: true },
          });
          if (found && found.status === 'ACTIVE') {
            req.customer = found;
            next();
            return;
          }
        }
      } catch {
        // Continue as guest
      }
    }
  }

  // 2. If not authenticated customer, inspect isolated GuestSession (`gsid` cookie)
  const gsidCookie = req.cookies?.[GUEST_SESSION_COOKIE] as string | undefined;
  if (gsidCookie) {
    const guestSession = await validateGuestSession(gsidCookie);
    if (guestSession) {
      req.guestSession = {
        id: guestSession.id,
        csrfSecret: guestSession.csrfSecret,
      };
    }
  }

  next();
}

export async function requireAdminAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const tokens: string[] = [];
  const bearer = extractBearerToken(req);
  if (bearer) tokens.push(bearer);
  const cookieToken = req.cookies?.accessToken as string | undefined;
  if (cookieToken && !tokens.includes(cookieToken)) {
    tokens.push(cookieToken);
  }
  if (tokens.length === 0) throw new UnauthorizedError('Admin authentication required');

  let admin = null;

  for (const token of tokens) {
    try {
      const payload = verifyAccessToken(token);
      if (payload.type === 'admin') {
        const found = await prisma.adminUser.findUnique({
          where: { id: payload.sub },
          select: { id: true, email: true, fullName: true, role: true, permissions: true, status: true },
        });
        if (found && found.status === 'ACTIVE') {
          admin = found;
          break;
        }
      }
    } catch {
      // Continue to next candidate token
    }
  }

  if (!admin) {
    throw new UnauthorizedError('Administrator authentication required or token invalid');
  }

  req.admin = admin;
  next();
}

export function requireAdminRole(...allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.admin) throw new UnauthorizedError('Admin authentication required');
    if (req.admin.role === 'SUPER_ADMIN' || allowedRoles.includes(req.admin.role)) {
      next();
      return;
    }
    throw new ForbiddenError('Insufficient admin role permissions');
  };
}
