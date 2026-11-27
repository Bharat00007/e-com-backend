import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { authLimiter, otpResendLimiter, otpVerifyLimiter } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import {
    loginSchema,
    normalizeIndianMobile,
    registerSchema,
    resendOtpSchema,
    verifyOtpSchema,
} from '../validators/schemas';
import {
    AppError,
    BadRequestError,
    ConflictError,
    UnauthorizedError,
} from '../utils/errors';
import {
    hashToken,
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
} from '../utils/jwt';
import { buildCookieOptions } from '../utils/cookies';
import { generateSixDigitOtp, hashOtp, maskEmail, verifyOtpHash } from '../utils/otp';
import {
    getEmailConfigurationStatus,
    isSmtpConfigured,
    sendOtpVerificationEmail,
} from '../services/emailService';

const OTP_EXPIRY_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_RESEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_MAX_RESENDS_PER_HOUR = 5;
const OTP_MAX_FAILED_ATTEMPTS = 5;
const PENDING_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;

const router = Router();

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
router.get('/email-configuration-status', (_req: Request, res: Response) => {
    res.json({ success: true, data: getEmailConfigurationStatus() });
});

router.get('/session', async (req: Request, res: Response) => {
    const cookieToken = req.cookies?.accessToken as string | undefined;
    const authHeader = req.headers.authorization;
    const token = cookieToken ?? (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);

    if (!token) {
        res.json({ success: true, data: { authenticated: false, customer: null } });
        return;
    }

    try {
        const payload = verifyAccessToken(token);
        if (payload.type !== 'customer') {
            res.json({ success: true, data: { authenticated: false, customer: null } });
            return;
        }
        const customer = await prisma.customer.findUnique({
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
    } catch {
        res.json({ success: true, data: { authenticated: false, customer: null } });
    }
});

async function mergeGuestCart(req: Request, customerId: string) {
    const guestToken =
        (req.headers['x-guest-cart-token'] as string | undefined) ||
        (req.cookies?.guestCartToken as string | undefined);
    if (!guestToken) return;

    const guestCart = await prisma.cart.findUnique({
        where: { guestToken },
        include: { items: { include: { variant: true } } },
    });
    if (!guestCart) return;
    if (guestCart.items.length === 0) {
        await prisma.cart.delete({ where: { id: guestCart.id } });
        return;
    }

    let customerCart = await prisma.cart.findUnique({
        where: { customerId },
        include: { items: true },
    });
    if (!customerCart) {
        customerCart = await prisma.cart.create({
            data: { customerId },
            include: { items: true },
        });
    }

    const existingMap = new Map(
        customerCart.items.map((ci) => [`${ci.variantId}:${ci.isSubscription}`, ci])
    );

    const txOps = [
        ...guestCart.items.map((item) => {
            const existing = existingMap.get(`${item.variantId}:${item.isSubscription}`);
            const maxStock = item.variant?.stockQuantity ?? 20;
            if (existing) {
                const combinedQty = Math.min(existing.quantity + item.quantity, maxStock);
                return prisma.cartItem.update({
                    where: { id: existing.id },
                    data: { quantity: combinedQty },
                });
            }
            const cappedQty = Math.min(item.quantity, maxStock);
            return prisma.cartItem.create({
                data: {
                    cartId: customerCart.id,
                    variantId: item.variantId,
                    quantity: cappedQty,
                    isSubscription: item.isSubscription,
                    frequencyWeeks: item.frequencyWeeks,
                },
            });
        }),
        prisma.cart.delete({ where: { id: guestCart.id } }),
    ];

    await prisma.$transaction(txOps);
}

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie('accessToken', accessToken, buildCookieOptions(15 * 60 * 1000));
    res.cookie('refreshToken', refreshToken, buildCookieOptions(7 * 24 * 60 * 60 * 1000));
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
router.post('/register', authLimiter, validate(registerSchema), async (req: Request, res: Response) => {
    const { fullName, email, phone, password, marketingConsent } = req.body as {
        fullName: string;
        email: string;
        phone?: string;
        password: string;
        marketingConsent?: boolean;
    };
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone ? normalizeIndianMobile(phone) : null;

    // Opportunistically purge stale expired pending registrations (> 24h)
    await prisma.pendingRegistration.deleteMany({
        where: {
            otpExpiresAt: { lt: new Date(Date.now() - PENDING_CLEANUP_AGE_MS) },
            status: { not: 'VERIFIED' },
        },
    });

    const existingCustomer = await prisma.customer.findUnique({
        where: { email: normalizedEmail },
    });
    if (existingCustomer) {
        throw new ConflictError('An account with this email address already exists');
    }

    if (normalizedPhone) {
        const existingByPhone = await prisma.customer.findUnique({
            where: { phone: normalizedPhone },
        });
        if (existingByPhone) {
            throw new ConflictError('An account with this mobile number already exists');
        }
    }

    const isDevOtpMode =
        env.NODE_ENV !== 'production' &&
        env.OTP_MODE === 'development' &&
        Boolean(env.ENABLE_TEST_OTP);

    if (!isDevOtpMode && !isSmtpConfigured()) {
        throw new AppError(
            'Email verification service (SMTP) is not configured yet. Please configure SMTP settings in backend/.env.',
            503,
            'EMAIL_SERVICE_NOT_CONFIGURED'
        );
    }

    const existingPending = await prisma.pendingRegistration.findUnique({
        where: { normalizedEmail },
    });

    const now = new Date();
    let resendCount = 0;
    let resendWindowStart = now;

    if (existingPending && existingPending.status === 'PENDING') {
        const elapsedMs = now.getTime() - existingPending.lastResendAt.getTime();
        if (elapsedMs < OTP_RESEND_COOLDOWN_MS) {
            const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsedMs) / 1000);
            throw new AppError(
                `A verification code was recently sent. Please wait ${waitSec} seconds before requesting another.`,
                429,
                'OTP_RESEND_COOLDOWN',
                { retryAfterSeconds: waitSec }
            );
        }

        const inSameWindow =
            now.getTime() - existingPending.resendWindowStart.getTime() < OTP_RESEND_WINDOW_MS;
        resendWindowStart = inSameWindow ? existingPending.resendWindowStart : now;
        resendCount = inSameWindow ? existingPending.resendCount + 1 : 1;
        if (resendCount > OTP_MAX_RESENDS_PER_HOUR) {
            throw new AppError(
                'Maximum verification code requests reached for this hour. Please try again later.',
                429,
                'OTP_RESEND_LIMIT'
            );
        }
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const otp = generateSixDigitOtp();
    const otpHash = hashOtp(normalizedEmail, otp);
    const otpExpiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);

    const pendingRecord = await prisma.pendingRegistration.upsert({
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
            await sendOtpVerificationEmail({
                toEmail: normalizedEmail,
                fullName,
                otp,
                expiresInMinutes: 5,
            });
        } catch (err) {
            // Do not leave a newly created unsent OTP record behind if SMTP delivery fails
            if (!existingPending) {
                await prisma.pendingRegistration
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
            maskedEmail: maskEmail(normalizedEmail),
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
router.post('/verify-otp', otpVerifyLimiter, validate(verifyOtpSchema), async (req: Request, res: Response) => {
    const { email, otp } = req.body as { email: string; otp: string };
    const normalizedEmail = email.trim().toLowerCase();

    const pending = await prisma.pendingRegistration.findUnique({
        where: { normalizedEmail },
    });

    if (!pending) {
        throw new AppError(
            'No pending verification found for this email address. Please register first.',
            400,
            'OTP_NOT_FOUND'
        );
    }

    if (pending.status === 'VERIFIED') {
        throw new AppError(
            'This verification code has already been used. Please sign in to your account.',
            400,
            'OTP_ALREADY_USED'
        );
    }

    if (pending.status === 'INVALIDATED' || pending.failedAttempts >= OTP_MAX_FAILED_ATTEMPTS) {
        if (pending.status !== 'INVALIDATED') {
            await prisma.pendingRegistration.update({
                where: { id: pending.id },
                data: { status: 'INVALIDATED' },
            });
        }
        throw new AppError(
            'This verification code was invalidated after too many incorrect attempts. Please request a new OTP.',
            429,
            'OTP_MAX_ATTEMPTS'
        );
    }

    const now = new Date();
    if (pending.otpExpiresAt <= now) {
        throw new AppError(
            'Verification code has expired. Please request a new code.',
            400,
            'OTP_EXPIRED'
        );
    }

    const matches = verifyOtpHash(normalizedEmail, otp, pending.otpHash);
    if (!matches) {
        const updated = await prisma.pendingRegistration.update({
            where: { id: pending.id },
            data: {
                failedAttempts: { increment: 1 },
            },
            select: { failedAttempts: true },
        });

        if (updated.failedAttempts >= OTP_MAX_FAILED_ATTEMPTS) {
            await prisma.pendingRegistration.update({
                where: { id: pending.id },
                data: { status: 'INVALIDATED' },
            });
            throw new AppError(
                'Too many incorrect attempts. This verification code has been invalidated — please request a new OTP.',
                429,
                'OTP_MAX_ATTEMPTS'
            );
        }

        const remaining = OTP_MAX_FAILED_ATTEMPTS - updated.failedAttempts;
        throw new AppError(
            `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
            400,
            'OTP_INVALID',
            { otp: [`Invalid verification code (${remaining} attempts remaining)`] }
        );
    }

    const existingCustomer = await prisma.customer.findUnique({
        where: { email: normalizedEmail },
    });
    if (existingCustomer) {
        throw new ConflictError('An account with this email address already exists');
    }

    const customer = await prisma.$transaction(
        async (tx) => {
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
                throw new AppError(
                    'This verification code has already been used or expired.',
                    400,
                    'OTP_ALREADY_USED'
                );
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
        },
        { timeout: 15000, maxWait: 10000 }
    );

    const payload = { sub: customer.id, type: 'customer' as const };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    await prisma.refreshToken.create({
        data: {
            tokenHash: hashToken(refreshToken),
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
router.post('/resend-otp', otpResendLimiter, validate(resendOtpSchema), async (req: Request, res: Response) => {
    const { email } = req.body as { email: string };
    const normalizedEmail = email.trim().toLowerCase();

    const isDevOtpMode =
        env.NODE_ENV !== 'production' &&
        env.OTP_MODE === 'development' &&
        Boolean(env.ENABLE_TEST_OTP);

    if (!isDevOtpMode && !isSmtpConfigured()) {
        throw new AppError(
            'Email verification service (SMTP) is not configured yet. Please configure SMTP settings in backend/.env.',
            503,
            'EMAIL_SERVICE_NOT_CONFIGURED'
        );
    }

    const genericResponse = {
        success: true,
        data: {
            message: 'If a pending verification exists for this email, a new verification code has been sent.',
            expiresInSeconds: 300,
            resendCooldownSeconds: 60,
        },
    };

    const existingCustomer = await prisma.customer.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
    });
    if (existingCustomer) {
        res.json(genericResponse);
        return;
    }

    const pending = await prisma.pendingRegistration.findUnique({
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
        throw new AppError(
            `Please wait ${waitSec} seconds before requesting another verification code.`,
            429,
            'OTP_RESEND_COOLDOWN',
            { retryAfterSeconds: waitSec }
        );
    }

    const inSameWindow = now.getTime() - pending.resendWindowStart.getTime() < OTP_RESEND_WINDOW_MS;
    const resendWindowStart = inSameWindow ? pending.resendWindowStart : now;
    const nextResendCount = inSameWindow ? pending.resendCount + 1 : 1;

    if (nextResendCount > OTP_MAX_RESENDS_PER_HOUR) {
        throw new AppError(
            'Maximum resend limit reached (5 per hour). Please try again later.',
            429,
            'OTP_RESEND_LIMIT'
        );
    }

    const otp = generateSixDigitOtp();
    const otpHash = hashOtp(normalizedEmail, otp);
    const otpExpiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);

    await prisma.pendingRegistration.update({
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
            await sendOtpVerificationEmail({
                toEmail: normalizedEmail,
                fullName: pending.fullName,
                otp,
                expiresInMinutes: 5,
            });
        } catch (err) {
            // Restore previous metadata on send failure so failed SMTP doesn't count against resend quota
            await prisma.pendingRegistration
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
            maskedEmail: maskEmail(normalizedEmail),
            expiresInSeconds: 300,
            resendCooldownSeconds: 60,
            ...(isDevOtpMode ? { devOtp: otp, isDevMode: true } : {}),
        },
    });
});

router.post('/login', authLimiter, validate(loginSchema), async (req: Request, res: Response) => {
    const { email: rawEmail, identifier: rawIdentifier, password } = req.body as {
        email?: string;
        identifier?: string;
        password: string;
    };
    const trimmed = (rawEmail ?? rawIdentifier ?? '').trim();
    const normalizedPhone = !trimmed.includes('@') ? normalizeIndianMobile(trimmed) : null;
    const normalizedEmail = trimmed.includes('@') ? trimmed.toLowerCase() : null;

    const customer = await prisma.customer.findFirst({
        where: {
            OR: [
                ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
                ...(normalizedPhone ? [{ phone: normalizedPhone }] : [{ phone: trimmed }]),
            ],
        },
    });

    if (!customer) {
        if (normalizedEmail) {
            const pending = await prisma.pendingRegistration.findUnique({
                where: { normalizedEmail },
            });
            if (pending && pending.status !== 'VERIFIED' && (await bcrypt.compare(password, pending.passwordHash))) {
                throw new AppError(
                    'Your email address has not been verified yet. Please enter your 6-digit verification code to activate your account.',
                    403,
                    'EMAIL_NOT_VERIFIED',
                    { email: normalizedEmail }
                );
            }
        }
        throw new UnauthorizedError('Invalid credentials');
    }

    if (!(await bcrypt.compare(password, customer.passwordHash))) {
        throw new UnauthorizedError('Invalid credentials');
    }
    if (customer.email && !customer.emailVerified) {
        throw new AppError(
            'Your email address has not been verified yet. Please verify your email before signing in.',
            403,
            'EMAIL_NOT_VERIFIED'
        );
    }
    if (customer.status !== 'ACTIVE') {
        throw new UnauthorizedError('Account is suspended or inactive');
    }

    const payload = { sub: customer.id, type: 'customer' as const };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    await prisma.refreshToken.create({
        data: {
            tokenHash: hashToken(refreshToken),
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

router.post('/admin/login', authLimiter, validate(loginSchema), async (req: Request, res: Response) => {
    const { email, identifier, password } = req.body as {
        email?: string;
        identifier?: string;
        password: string;
    };
    const lookupEmail = (email ?? identifier ?? '').trim().toLowerCase();
    const admin = await prisma.adminUser.findUnique({ where: { email: lookupEmail } });
    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
        throw new UnauthorizedError('Invalid administrator credentials');
    }
    if (admin.status !== 'ACTIVE') {
        throw new UnauthorizedError('Administrator account is suspended or inactive');
    }

    const payload = { sub: admin.id, type: 'admin' as const, role: admin.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    await prisma.refreshToken.create({
        data: {
            tokenHash: hashToken(refreshToken),
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

router.post('/refresh', async (req: Request, res: Response) => {
    const token = req.cookies?.refreshToken as string | undefined;
    if (!token) throw new UnauthorizedError('Refresh token missing');

    const payload = verifyRefreshToken(token);
    const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(token) },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
        throw new UnauthorizedError('Refresh token expired or revoked');
    }

    const accessToken = signAccessToken({
        sub: payload.sub,
        type: payload.type,
        role: payload.role,
    });

    res.cookie('accessToken', accessToken, buildCookieOptions(15 * 60 * 1000));
    res.setHeader('x-auth-token', accessToken);

    res.json({
        success: true,
        data: {
            token: accessToken,
            accessToken,
        },
    });
});

router.post('/logout', async (req: Request, res: Response) => {
    const token = req.cookies?.refreshToken as string | undefined;
    if (token) {
        await prisma.refreshToken.updateMany({
            where: { tokenHash: hashToken(token) },
            data: { revokedAt: new Date() },
        });
    }
    const clearOpts = buildCookieOptions();
    res.clearCookie('accessToken', clearOpts);
    res.clearCookie('refreshToken', clearOpts);
    res.json({ success: true, message: 'Logged out successfully' });
});

router.post('/verify-email', async (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (!token) throw new BadRequestError('Verification token required');

    const customer = await prisma.customer.findFirst({ where: { emailVerifyToken: token } });
    if (!customer) throw new BadRequestError('Invalid verification token');

    await prisma.customer.update({
        where: { id: customer.id },
        data: { emailVerified: true, emailVerifyToken: null },
    });

    res.json({ success: true, message: 'Email verified successfully' });
});

router.post('/forgot-password', authLimiter, async (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };
    if (!email) throw new BadRequestError('Email is required');

    const customer = await prisma.customer.findUnique({ where: { email } });
    if (customer) {
        const resetToken = crypto.randomBytes(24).toString('hex');
        await prisma.customer.update({
            where: { id: customer.id },
            data: {
                passwordResetToken: hashToken(resetToken),
                passwordResetExpiry: new Date(Date.now() + 60 * 60 * 1000),
            },
        });
    }

    res.json({
        success: true,
        message: 'If an account exists for that email, a password reset link has been queued.',
    });
});

router.post('/reset-password', authLimiter, async (req: Request, res: Response) => {
    const { token, password } = req.body as { token?: string; password?: string };
    if (!token || !password || password.length < 8) {
        throw new BadRequestError('Valid token and password (min 8 chars) required');
    }

    const customer = await prisma.customer.findFirst({
        where: {
            passwordResetToken: hashToken(token),
            passwordResetExpiry: { gt: new Date() },
        },
    });

    if (!customer) throw new BadRequestError('Invalid or expired password reset token');

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.customer.update({
        where: { id: customer.id },
        data: { passwordHash, passwordResetToken: null, passwordResetExpiry: null },
    });

    res.json({ success: true, message: 'Password updated successfully' });
});

export default router;
