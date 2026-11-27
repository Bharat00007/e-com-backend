import { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { verifyAccessToken } from '../utils/jwt';
import { prisma } from '../config/prisma';

function extractTokens(req: Request): string[] {
  const tokens: string[] = [];
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const headerToken = authHeader.slice(7).trim();
    if (headerToken) tokens.push(headerToken);
  }
  const cookieToken = req.cookies?.accessToken as string | undefined;
  if (cookieToken && !tokens.includes(cookieToken)) {
    tokens.push(cookieToken);
  }
  return tokens;
}

export async function requireCustomerAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const tokens = extractTokens(req);
  if (tokens.length === 0) throw new UnauthorizedError('Customer authentication required');

  let customer = null;

  for (const token of tokens) {
    try {
      const payload = verifyAccessToken(token);
      if (payload.type === 'customer') {
        const found = await prisma.customer.findUnique({
          where: { id: payload.sub },
          select: { id: true, email: true, fullName: true, status: true },
        });
        if (found && found.status === 'ACTIVE') {
          customer = found;
          break;
        }
      }
    } catch {
      // Continue to next candidate token
    }
  }

  if (!customer) {
    throw new UnauthorizedError('Customer authentication required or token invalid');
  }

  req.customer = customer;
  next();
}

export async function optionalCustomerAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const tokens = extractTokens(req);
  for (const token of tokens) {
    try {
      const payload = verifyAccessToken(token);
      if (payload.type === 'customer') {
        const customer = await prisma.customer.findUnique({
          where: { id: payload.sub },
          select: { id: true, email: true, fullName: true, status: true },
        });
        if (customer && customer.status === 'ACTIVE') {
          req.customer = customer;
          break;
        }
      }
    } catch {
      // Ignore invalid optional token and continue
    }
  }
  next();
}

export async function requireAdminAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const tokens = extractTokens(req);
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
