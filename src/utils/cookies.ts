import { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env';

export const CUSTOMER_SESSION_COOKIE = 'sid';
export const GUEST_SESSION_COOKIE = 'gsid';
export const CSRF_NONCE_COOKIE = 'csrfNonce';

export function isSecureRequest(req?: Request): boolean {
    if (process.env.VERCEL === '1') return true;
    if (req) {
        const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)
            ?.split(',')[0]
            ?.trim()
            ?.toLowerCase();
        if (req.secure || forwardedProto === 'https') {
            return true;
        }
        return false;
    }
    return env.NODE_ENV === 'production';
}

/**
 * Returns request-aware HTTP-only cookie attributes.
 * Never sets Secure:true on plain HTTP requests (localhost HTTP or supertest)
 * while enforcing Secure:true + SameSite=None/Lax appropriately on Vercel/HTTPS.
 */
export function buildCookieOptions(
    maxAge?: number,
    req?: Request,
    options?: { httpOnly?: boolean; sameSiteOverride?: 'lax' | 'strict' | 'none' }
): CookieOptions {
    const secure = isSecureRequest(req);
    const envSameSite = env.COOKIE_SAME_SITE;
    let sameSite: 'lax' | 'strict' | 'none' =
        options?.sameSiteOverride ?? envSameSite ?? (secure ? 'none' : 'lax');

    // Browsers reject SameSite=None cookies unless Secure=true
    if (sameSite === 'none' && !secure) {
        sameSite = 'lax';
    }

    const validDomain =
        env.COOKIE_DOMAIN &&
            env.COOKIE_DOMAIN !== 'localhost' &&
            !env.COOKIE_DOMAIN.includes('localhost')
            ? env.COOKIE_DOMAIN
            : undefined;

    return {
        httpOnly: options?.httpOnly ?? true,
        secure,
        sameSite,
        path: '/',
        ...(sameSite === 'none' && secure ? { partitioned: true } : {}),
        ...(validDomain ? { domain: validDomain } : {}),
        ...(maxAge !== undefined ? { maxAge } : {}),
    };
}

export function clearLegacyJwtCookies(res: Response, req?: Request): void {
    const opts = buildCookieOptions(undefined, req);
    res.clearCookie('accessToken', opts);
    res.clearCookie('refreshToken', opts);
}

export function clearLegacyAndSessionCookies(res: Response, req?: Request): void {
    const opts = buildCookieOptions(undefined, req);
    res.clearCookie(CUSTOMER_SESSION_COOKIE, opts);
    clearLegacyJwtCookies(res, req);
}

export function clearGuestSessionCookies(res: Response, req?: Request): void {
    const opts = buildCookieOptions(undefined, req);
    res.clearCookie(GUEST_SESSION_COOKIE, opts);
    res.clearCookie('guestCartToken', opts);
}
