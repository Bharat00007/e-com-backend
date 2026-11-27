"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCookieOptions = buildCookieOptions;
const env_1 = require("../config/env");
/** Returns consistent HTTP-only cookie attributes across auth and guest cart routes. */
function buildCookieOptions(maxAge) {
    const isVercel = process.env.VERCEL === '1';
    const isProd = env_1.env.NODE_ENV === 'production' || isVercel;
    const sameSite = env_1.env.COOKIE_SAME_SITE ?? (isProd ? 'none' : 'none');
    const secure = true;
    const validDomain = env_1.env.COOKIE_DOMAIN &&
        env_1.env.COOKIE_DOMAIN !== 'localhost' &&
        !env_1.env.COOKIE_DOMAIN.includes('localhost')
        ? env_1.env.COOKIE_DOMAIN
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
