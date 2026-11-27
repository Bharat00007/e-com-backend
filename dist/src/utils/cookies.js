"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCookieOptions = buildCookieOptions;
const env_1 = require("../config/env");
/** Returns consistent HTTP-only cookie attributes across auth and guest cart routes. */
function buildCookieOptions(maxAge) {
    const isProd = env_1.env.NODE_ENV === 'production';
    const sameSite = env_1.env.COOKIE_SAME_SITE ?? (isProd ? 'none' : 'lax');
    const secure = isProd || sameSite === 'none';
    return {
        httpOnly: true,
        secure,
        sameSite,
        path: '/',
        ...(env_1.env.COOKIE_DOMAIN && env_1.env.COOKIE_DOMAIN !== 'localhost'
            ? { domain: env_1.env.COOKIE_DOMAIN }
            : {}),
        ...(maxAge !== undefined ? { maxAge } : {}),
    };
}
