"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = require("../config/prisma");
const env_1 = require("../config/env");
const rateLimit_1 = require("../middleware/rateLimit");
const validate_1 = require("../middleware/validate");
const schemas_1 = require("../validators/schemas");
const errors_1 = require("../utils/errors");
const jwt_1 = require("../utils/jwt");
const cookies_1 = require("../utils/cookies");
const otp_1 = require("../utils/otp");
const emailService_1 = require("../services/emailService");
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_RESEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_MAX_RESENDS_PER_HOUR = 5;
const OTP_MAX_FAILED_ATTEMPTS = 5;
const PENDING_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
const router = (0, express_1.Router)();
/**
 * @openapi
 * /auth/email-configuration-status:
 *   get:
 *     tags: [Auth]
 *     summary: Check whether SMTP credentials are configured for email OTP delivery
 *     responses:
 *       200:
 *         description: SMTP configuration status (without exposing credentials)
 */
router.get('/email-configuration-status', (_req, res) => {
    res.json({ success: true, data: (0, emailService_1.getEmailConfigurationStatus)() });
});
router.get('/session', async (req, res) => {
    const cookieToken = req.cookies?.accessToken;
    const authHeader = req.headers.authorization;
    const token = cookieToken ?? (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);
    if (!token) {
        res.json({ success: true, data: { authenticated: false, customer: null } });
        return;
    }
    try {
        const payload = (0, jwt_1.verifyAccessToken)(token);
        if (payload.type !== 'customer') {
            res.json({ success: true, data: { authenticated: false, customer: null } });
            return;
        }
        const customer = await prisma_1.prisma.customer.findUnique({
            where: { id: payload.sub },
            select: {
                id: true,
                fullName: true,
                email: true,
                phone: true,
                emailVerified: true,
                marketingConsent: true,
                status: true,
            },
        });
        if (!customer || customer.status !== 'ACTIVE') {
            res.json({ success: true, data: { authenticated: false, customer: null } });
            return;
        }
        const { status: _status, ...safeCustomer } = customer;
        res.json({ success: true, data: { authenticated: true, customer: safeCustomer } });
    }
    catch {
        res.json({ success: true, data: { authenticated: false, customer: null } });
    }
});
async function mergeGuestCart(req, customerId) {
    const guestToken = req.headers['x-guest-cart-token'] ||
        req.cookies?.guestCartToken;
    if (!guestToken)
        return;
    const guestCart = await prisma_1.prisma.cart.findUnique({
        where: { guestToken },
        include: { items: { include: { variant: true } } },
    });
    if (!guestCart)
        return;
    if (guestCart.items.length === 0) {
        await prisma_1.prisma.cart.delete({ where: { id: guestCart.id } });
        return;
    }
    let customerCart = await prisma_1.prisma.cart.findUnique({
        where: { customerId },
        include: { items: true },
    });
    if (!customerCart) {
        customerCart = await prisma_1.prisma.cart.create({
            data: { customerId },
            include: { items: true },
        });
    }
    const existingMap = new Map(customerCart.items.map((ci) => [`${ci.variantId}:${ci.isSubscription}`, ci]));
    const txOps = [
        ...guestCart.items.map((item) => {
            const existing = existingMap.get(`${item.variantId}:${item.isSubscription}`);
            const maxStock = item.variant?.stockQuantity ?? 20;
            if (existing) {
                const combinedQty = Math.min(existing.quantity + item.quantity, maxStock);
                return prisma_1.prisma.cartItem.update({
                    where: { id: existing.id },
                    data: { quantity: combinedQty },
                });
            }
            const cappedQty = Math.min(item.quantity, maxStock);
            return prisma_1.prisma.cartItem.create({
                data: {
                    cartId: customerCart.id,
                    variantId: item.variantId,
                    quantity: cappedQty,
                    isSubscription: item.isSubscription,
                    frequencyWeeks: item.frequencyWeeks,
                },
            });
        }),
        prisma_1.prisma.cart.delete({ where: { id: guestCart.id } }),
    ];
    await prisma_1.prisma.$transaction(txOps);
}
function setAuthCookies(res, accessToken, refreshToken) {
    res.cookie('accessToken', accessToken, (0, cookies_1.buildCookieOptions)(15 * 60 * 1000));
    res.cookie('refreshToken', refreshToken, (0, cookies_1.buildCookieOptions)(7 * 24 * 60 * 60 * 1000));
}
/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Initiate email registration and send 6-digit OTP via Nodemailer SMTP
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fullName, email, password]
 *             properties:
 *               fullName: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               marketingConsent: { type: boolean }
 *     responses:
 *       202:
 *         description: Pending registration created and 6-digit OTP dispatched
 *       409:
 *         description: Email already registered
 *       429:
 *         description: Cooldown or rate limit active
 *       503:
 *         description: SMTP email service not configured
 */
router.post('/register', rateLimit_1.authLimiter, (0, validate_1.validate)(schemas_1.registerSchema), async (req, res) => {
    const { fullName, email, phone, password, marketingConsent } = req.body;
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone ? (0, schemas_1.normalizeIndianMobile)(phone) : null;
    // Opportunistically purge stale expired pending registrations (> 24h)
    await prisma_1.prisma.pendingRegistration.deleteMany({
        where: {
            otpExpiresAt: { lt: new Date(Date.now() - PENDING_CLEANUP_AGE_MS) },
            status: { not: 'VERIFIED' },
        },
    });
    const existingCustomer = await prisma_1.prisma.customer.findUnique({
        where: { email: normalizedEmail },
    });
    if (existingCustomer) {
        throw new errors_1.ConflictError('An account with this email address already exists');
    }
    if (normalizedPhone) {
        const existingByPhone = await prisma_1.prisma.customer.findUnique({
            where: { phone: normalizedPhone },
        });
        if (existingByPhone) {
            throw new errors_1.ConflictError('An account with this mobile number already exists');
        }
    }
    const isDevOtpMode = env_1.env.NODE_ENV !== 'production' &&
        env_1.env.OTP_MODE === 'development' &&
        Boolean(env_1.env.ENABLE_TEST_OTP);
    if (!isDevOtpMode && !(0, emailService_1.isSmtpConfigured)()) {
        throw new errors_1.AppError('Email verification service (SMTP) is not configured yet. Please configure SMTP settings in backend/.env.', 503, 'EMAIL_SERVICE_NOT_CONFIGURED');
    }
    const existingPending = await prisma_1.prisma.pendingRegistration.findUnique({
        where: { normalizedEmail },
    });
    const now = new Date();
    let resendCount = 0;
    let resendWindowStart = now;
    if (existingPending && existingPending.status === 'PENDING') {
        const elapsedMs = now.getTime() - existingPending.lastResendAt.getTime();
        if (elapsedMs < OTP_RESEND_COOLDOWN_MS) {
            const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsedMs) / 1000);
            throw new errors_1.AppError(`A verification code was recently sent. Please wait ${waitSec} seconds before requesting another.`, 429, 'OTP_RESEND_COOLDOWN', { retryAfterSeconds: waitSec });
        }
        const inSameWindow = now.getTime() - existingPending.resendWindowStart.getTime() < OTP_RESEND_WINDOW_MS;
        resendWindowStart = inSameWindow ? existingPending.resendWindowStart : now;
        resendCount = inSameWindow ? existingPending.resendCount + 1 : 1;
        if (resendCount > OTP_MAX_RESENDS_PER_HOUR) {
            throw new errors_1.AppError('Maximum verification code requests reached for this hour. Please try again later.', 429, 'OTP_RESEND_LIMIT');
        }
    }
    const passwordHash = await bcryptjs_1.default.hash(password, 12);
    const otp = (0, otp_1.generateSixDigitOtp)();
    const otpHash = (0, otp_1.hashOtp)(normalizedEmail, otp);
    const otpExpiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
    const pendingRecord = await prisma_1.prisma.pendingRegistration.upsert({
        where: { normalizedEmail },
        update: {
            email: normalizedEmail,
            fullName,
            phone: normalizedPhone,
            passwordHash,
            marketingConsent: Boolean(marketingConsent),
            otpHash,
            otpExpiresAt,
            failedAttempts: 0,
            resendCount,
            resendWindowStart,
            lastResendAt: now,
            status: 'PENDING',
            verifiedAt: null,
        },
        create: {
            email: normalizedEmail,
            normalizedEmail,
            fullName,
            phone: normalizedPhone,
            passwordHash,
            marketingConsent: Boolean(marketingConsent),
            otpHash,
            otpExpiresAt,
            failedAttempts: 0,
            resendCount: 0,
            resendWindowStart: now,
            lastResendAt: now,
            status: 'PENDING',
        },
    });
    if (!isDevOtpMode) {
        try {
            await (0, emailService_1.sendOtpVerificationEmail)({
                toEmail: normalizedEmail,
                fullName,
                otp,
                expiresInMinutes: 5,
            });
        }
        catch (err) {
            // Do not leave a newly created unsent OTP record behind if SMTP delivery fails
            if (!existingPending) {
                await prisma_1.prisma.pendingRegistration
                    .delete({ where: { id: pendingRecord.id } })
                    .catch(() => undefined);
            }
            throw err;
        }
    }
    res.status(202).json({
        success: true,
        data: {
            verificationRequired: true,
            email: normalizedEmail,
            maskedEmail: (0, otp_1.maskEmail)(normalizedEmail),
            expiresInSeconds: 300,
            resendCooldownSeconds: 60,
            message: isDevOtpMode
                ? 'Development demo OTP generated (email bypassed).'
                : 'Verification code sent to your email address.',
            ...(isDevOtpMode ? { devOtp: otp, isDevMode: true } : {}),
        },
    });
});
/**
 * @openapi
 * /auth/verify-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Verify 6-digit email OTP, activate customer account, merge guest cart, and set auth cookies
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp]
 *             properties:
 *               email: { type: string, format: email }
 *               otp: { type: string, pattern: '^[0-9]{6}$' }
 *     responses:
 *       201:
 *         description: Email verified and customer session established
 *       400:
 *         description: Invalid, expired, or already-used OTP
 *       429:
 *         description: Too many invalid attempts
 */
router.post('/verify-otp', rateLimit_1.otpVerifyLimiter, (0, validate_1.validate)(schemas_1.verifyOtpSchema), async (req, res) => {
    const { email, otp } = req.body;
    const normalizedEmail = email.trim().toLowerCase();
    const pending = await prisma_1.prisma.pendingRegistration.findUnique({
        where: { normalizedEmail },
    });
    if (!pending) {
        throw new errors_1.AppError('No pending verification found for this email address. Please register first.', 400, 'OTP_NOT_FOUND');
    }
    if (pending.status === 'VERIFIED') {
        throw new errors_1.AppError('This verification code has already been used. Please sign in to your account.', 400, 'OTP_ALREADY_USED');
    }
    if (pending.status === 'INVALIDATED' || pending.failedAttempts >= OTP_MAX_FAILED_ATTEMPTS) {
        if (pending.status !== 'INVALIDATED') {
            await prisma_1.prisma.pendingRegistration.update({
                where: { id: pending.id },
                data: { status: 'INVALIDATED' },
            });
        }
        throw new errors_1.AppError('This verification code was invalidated after too many incorrect attempts. Please request a new OTP.', 429, 'OTP_MAX_ATTEMPTS');
    }
    const now = new Date();
    if (pending.otpExpiresAt <= now) {
        throw new errors_1.AppError('Verification code has expired. Please request a new code.', 400, 'OTP_EXPIRED');
    }
    const matches = (0, otp_1.verifyOtpHash)(normalizedEmail, otp, pending.otpHash);
    if (!matches) {
        const updated = await prisma_1.prisma.pendingRegistration.update({
            where: { id: pending.id },
            data: {
                failedAttempts: { increment: 1 },
            },
            select: { failedAttempts: true },
        });
        if (updated.failedAttempts >= OTP_MAX_FAILED_ATTEMPTS) {
            await prisma_1.prisma.pendingRegistration.update({
                where: { id: pending.id },
                data: { status: 'INVALIDATED' },
            });
            throw new errors_1.AppError('Too many incorrect attempts. This verification code has been invalidated — please request a new OTP.', 429, 'OTP_MAX_ATTEMPTS');
        }
        const remaining = OTP_MAX_FAILED_ATTEMPTS - updated.failedAttempts;
        throw new errors_1.AppError(`Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`, 400, 'OTP_INVALID', { otp: [`Invalid verification code (${remaining} attempts remaining)`] });
    }
    const existingCustomer = await prisma_1.prisma.customer.findUnique({
        where: { email: normalizedEmail },
    });
    if (existingCustomer) {
        throw new errors_1.ConflictError('An account with this email address already exists');
    }
    const customer = await prisma_1.prisma.$transaction(async (tx) => {
        const claim = await tx.pendingRegistration.updateMany({
            where: {
                id: pending.id,
                status: 'PENDING',
                otpHash: pending.otpHash,
                otpExpiresAt: { gt: new Date() },
                failedAttempts: { lt: OTP_MAX_FAILED_ATTEMPTS },
            },
            data: {
                status: 'VERIFIED',
                verifiedAt: new Date(),
            },
        });
        if (claim.count !== 1) {
            throw new errors_1.AppError('This verification code has already been used or expired.', 400, 'OTP_ALREADY_USED');
        }
        return tx.customer.create({
            data: {
                fullName: pending.fullName,
                email: pending.normalizedEmail,
                phone: pending.phone,
                passwordHash: pending.passwordHash,
                emailVerified: true,
                marketingConsent: pending.marketingConsent,
                status: 'ACTIVE',
            },
            select: {
                id: true,
                fullName: true,
                email: true,
                phone: true,
                emailVerified: true,
                marketingConsent: true,
            },
        });
    }, { timeout: 15000, maxWait: 10000 });
    const payload = { sub: customer.id, type: 'customer' };
    const accessToken = (0, jwt_1.signAccessToken)(payload);
    const refreshToken = (0, jwt_1.signRefreshToken)(payload);
    await prisma_1.prisma.refreshToken.create({
        data: {
            tokenHash: (0, jwt_1.hashToken)(refreshToken),
            customerId: customer.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
    });
    await mergeGuestCart(req, customer.id);
    setAuthCookies(res, accessToken, refreshToken);
    res.setHeader('x-auth-token', accessToken);
    res.status(201).json({
        success: true,
        data: {
            token: accessToken,
            accessToken,
            customer,
        },
    });
});
/**
 * @openapi
 * /auth/resend-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Resend fresh 6-digit email OTP after 60s cooldown (max 5/hour/email)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Fresh OTP sent if pending verification exists
 *       429:
 *         description: Resend cooldown or hourly limit reached
 */
router.post('/resend-otp', rateLimit_1.otpResendLimiter, (0, validate_1.validate)(schemas_1.resendOtpSchema), async (req, res) => {
    const { email } = req.body;
    const normalizedEmail = email.trim().toLowerCase();
    const isDevOtpMode = env_1.env.NODE_ENV !== 'production' &&
        env_1.env.OTP_MODE === 'development' &&
        Boolean(env_1.env.ENABLE_TEST_OTP);
    if (!isDevOtpMode && !(0, emailService_1.isSmtpConfigured)()) {
        throw new errors_1.AppError('Email verification service (SMTP) is not configured yet. Please configure SMTP settings in backend/.env.', 503, 'EMAIL_SERVICE_NOT_CONFIGURED');
    }
    const genericResponse = {
        success: true,
        data: {
            message: 'If a pending verification exists for this email, a new verification code has been sent.',
            expiresInSeconds: 300,
            resendCooldownSeconds: 60,
        },
    };
    const existingCustomer = await prisma_1.prisma.customer.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
    });
    if (existingCustomer) {
        res.json(genericResponse);
        return;
    }
    const pending = await prisma_1.prisma.pendingRegistration.findUnique({
        where: { normalizedEmail },
    });
    if (!pending || pending.status === 'VERIFIED') {
        res.json(genericResponse);
        return;
    }
    const now = new Date();
    const elapsedMs = now.getTime() - pending.lastResendAt.getTime();
    if (elapsedMs < OTP_RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsedMs) / 1000);
        throw new errors_1.AppError(`Please wait ${waitSec} seconds before requesting another verification code.`, 429, 'OTP_RESEND_COOLDOWN', { retryAfterSeconds: waitSec });
    }
    const inSameWindow = now.getTime() - pending.resendWindowStart.getTime() < OTP_RESEND_WINDOW_MS;
    const resendWindowStart = inSameWindow ? pending.resendWindowStart : now;
    const nextResendCount = inSameWindow ? pending.resendCount + 1 : 1;
    if (nextResendCount > OTP_MAX_RESENDS_PER_HOUR) {
        throw new errors_1.AppError('Maximum resend limit reached (5 per hour). Please try again later.', 429, 'OTP_RESEND_LIMIT');
    }
    const otp = (0, otp_1.generateSixDigitOtp)();
    const otpHash = (0, otp_1.hashOtp)(normalizedEmail, otp);
    const otpExpiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
    await prisma_1.prisma.pendingRegistration.update({
        where: { id: pending.id },
        data: {
            otpHash,
            otpExpiresAt,
            failedAttempts: 0,
            status: 'PENDING',
            resendCount: nextResendCount,
            resendWindowStart,
            lastResendAt: now,
        },
    });
    if (!isDevOtpMode) {
        try {
            await (0, emailService_1.sendOtpVerificationEmail)({
                toEmail: normalizedEmail,
                fullName: pending.fullName,
                otp,
                expiresInMinutes: 5,
            });
        }
        catch (err) {
            // Restore previous metadata on send failure so failed SMTP doesn't count against resend quota
            await prisma_1.prisma.pendingRegistration
                .update({
                where: { id: pending.id },
                data: {
                    otpHash: pending.otpHash,
                    otpExpiresAt: pending.otpExpiresAt,
                    failedAttempts: pending.failedAttempts,
                    status: pending.status,
                    resendCount: pending.resendCount,
                    resendWindowStart: pending.resendWindowStart,
                    lastResendAt: pending.lastResendAt,
                },
            })
                .catch(() => undefined);
            throw err;
        }
    }
    res.json({
        success: true,
        data: {
            message: isDevOtpMode
                ? 'Fresh development demo OTP generated.'
                : 'A new verification code has been sent to your email address.',
            maskedEmail: (0, otp_1.maskEmail)(normalizedEmail),
            expiresInSeconds: 300,
            resendCooldownSeconds: 60,
            ...(isDevOtpMode ? { devOtp: otp, isDevMode: true } : {}),
        },
    });
});
router.post('/login', rateLimit_1.authLimiter, (0, validate_1.validate)(schemas_1.loginSchema), async (req, res) => {
    const { email: rawEmail, identifier: rawIdentifier, password } = req.body;
    const trimmed = (rawEmail ?? rawIdentifier ?? '').trim();
    const normalizedPhone = !trimmed.includes('@') ? (0, schemas_1.normalizeIndianMobile)(trimmed) : null;
    const normalizedEmail = trimmed.includes('@') ? trimmed.toLowerCase() : null;
    const customer = await prisma_1.prisma.customer.findFirst({
        where: {
            OR: [
                ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
                ...(normalizedPhone ? [{ phone: normalizedPhone }] : [{ phone: trimmed }]),
            ],
        },
    });
    if (!customer) {
        if (normalizedEmail) {
            const pending = await prisma_1.prisma.pendingRegistration.findUnique({
                where: { normalizedEmail },
            });
            if (pending && pending.status !== 'VERIFIED' && (await bcryptjs_1.default.compare(password, pending.passwordHash))) {
                throw new errors_1.AppError('Your email address has not been verified yet. Please enter your 6-digit verification code to activate your account.', 403, 'EMAIL_NOT_VERIFIED', { email: normalizedEmail });
            }
        }
        throw new errors_1.UnauthorizedError('Invalid credentials');
    }
    if (!(await bcryptjs_1.default.compare(password, customer.passwordHash))) {
        throw new errors_1.UnauthorizedError('Invalid credentials');
    }
    if (customer.email && !customer.emailVerified) {
        throw new errors_1.AppError('Your email address has not been verified yet. Please verify your email before signing in.', 403, 'EMAIL_NOT_VERIFIED');
    }
    if (customer.status !== 'ACTIVE') {
        throw new errors_1.UnauthorizedError('Account is suspended or inactive');
    }
    const payload = { sub: customer.id, type: 'customer' };
    const accessToken = (0, jwt_1.signAccessToken)(payload);
    const refreshToken = (0, jwt_1.signRefreshToken)(payload);
    await prisma_1.prisma.refreshToken.create({
        data: {
            tokenHash: (0, jwt_1.hashToken)(refreshToken),
            customerId: customer.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
    });
    await mergeGuestCart(req, customer.id);
    setAuthCookies(res, accessToken, refreshToken);
    res.setHeader('x-auth-token', accessToken);
    res.json({
        success: true,
        data: {
            token: accessToken,
            accessToken,
            customer: {
                id: customer.id,
                fullName: customer.fullName,
                email: customer.email,
                phone: customer.phone,
                emailVerified: customer.emailVerified,
                marketingConsent: customer.marketingConsent,
            },
        },
    });
});
router.post('/admin/login', rateLimit_1.authLimiter, (0, validate_1.validate)(schemas_1.loginSchema), async (req, res) => {
    const { email, identifier, password } = req.body;
    const lookupEmail = (email ?? identifier ?? '').trim().toLowerCase();
    const admin = await prisma_1.prisma.adminUser.findUnique({ where: { email: lookupEmail } });
    if (!admin || !(await bcryptjs_1.default.compare(password, admin.passwordHash))) {
        throw new errors_1.UnauthorizedError('Invalid administrator credentials');
    }
    if (admin.status !== 'ACTIVE') {
        throw new errors_1.UnauthorizedError('Administrator account is suspended or inactive');
    }
    const payload = { sub: admin.id, type: 'admin', role: admin.role };
    const accessToken = (0, jwt_1.signAccessToken)(payload);
    const refreshToken = (0, jwt_1.signRefreshToken)(payload);
    await prisma_1.prisma.refreshToken.create({
        data: {
            tokenHash: (0, jwt_1.hashToken)(refreshToken),
            adminId: admin.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
    });
    setAuthCookies(res, accessToken, refreshToken);
    res.json({
        success: true,
        data: {
            token: accessToken,
            admin: { id: admin.id, fullName: admin.fullName, email: admin.email, role: admin.role },
        },
    });
});
router.post('/refresh', async (req, res) => {
    const token = req.cookies?.refreshToken;
    if (!token)
        throw new errors_1.UnauthorizedError('Refresh token missing');
    const payload = (0, jwt_1.verifyRefreshToken)(token);
    const stored = await prisma_1.prisma.refreshToken.findUnique({
        where: { tokenHash: (0, jwt_1.hashToken)(token) },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        throw new errors_1.UnauthorizedError('Refresh token expired or revoked');
    }
    const accessToken = (0, jwt_1.signAccessToken)({
        sub: payload.sub,
        type: payload.type,
        role: payload.role,
    });
    res.cookie('accessToken', accessToken, (0, cookies_1.buildCookieOptions)(15 * 60 * 1000));
    res.setHeader('x-auth-token', accessToken);
    res.json({
        success: true,
        data: {
            token: accessToken,
            accessToken,
        },
    });
});
router.post('/logout', async (req, res) => {
    const token = req.cookies?.refreshToken;
    if (token) {
        await prisma_1.prisma.refreshToken.updateMany({
            where: { tokenHash: (0, jwt_1.hashToken)(token) },
            data: { revokedAt: new Date() },
        });
    }
    const clearOpts = (0, cookies_1.buildCookieOptions)();
    res.clearCookie('accessToken', clearOpts);
    res.clearCookie('refreshToken', clearOpts);
    res.json({ success: true, message: 'Logged out successfully' });
});
router.post('/verify-email', async (req, res) => {
    const { token } = req.body;
    if (!token)
        throw new errors_1.BadRequestError('Verification token required');
    const customer = await prisma_1.prisma.customer.findFirst({ where: { emailVerifyToken: token } });
    if (!customer)
        throw new errors_1.BadRequestError('Invalid verification token');
    await prisma_1.prisma.customer.update({
        where: { id: customer.id },
        data: { emailVerified: true, emailVerifyToken: null },
    });
    res.json({ success: true, message: 'Email verified successfully' });
});
router.post('/forgot-password', rateLimit_1.authLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email)
        throw new errors_1.BadRequestError('Email is required');
    const customer = await prisma_1.prisma.customer.findUnique({ where: { email } });
    if (customer) {
        const resetToken = crypto_1.default.randomBytes(24).toString('hex');
        await prisma_1.prisma.customer.update({
            where: { id: customer.id },
            data: {
                passwordResetToken: (0, jwt_1.hashToken)(resetToken),
                passwordResetExpiry: new Date(Date.now() + 60 * 60 * 1000),
            },
        });
    }
    res.json({
        success: true,
        message: 'If an account exists for that email, a password reset link has been queued.',
    });
});
router.post('/reset-password', rateLimit_1.authLimiter, async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password || password.length < 8) {
        throw new errors_1.BadRequestError('Valid token and password (min 8 chars) required');
    }
    const customer = await prisma_1.prisma.customer.findFirst({
        where: {
            passwordResetToken: (0, jwt_1.hashToken)(token),
            passwordResetExpiry: { gt: new Date() },
        },
    });
    if (!customer)
        throw new errors_1.BadRequestError('Invalid or expired password reset token');
    const passwordHash = await bcryptjs_1.default.hash(password, 12);
    await prisma_1.prisma.customer.update({
        where: { id: customer.id },
        data: { passwordHash, passwordResetToken: null, passwordResetExpiry: null },
    });
    res.json({ success: true, message: 'Password updated successfully' });
});
exports.default = router;
