import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import nodemailer from 'nodemailer';
import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { env } from '../src/config/env';
import { generateSixDigitOtp, hashOtp, maskEmail, verifyOtpHash } from '../src/utils/otp';

const app = createApp();

describe('Email OTP Registration & Authentication Security', () => {
    const createdCustomerIds: string[] = [];
    const createdEmails: string[] = [];
    const originalSmtp = {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        fromEmail: env.SMTP_FROM_EMAIL,
        otpMode: env.OTP_MODE,
        enableTestOtp: env.ENABLE_TEST_OTP,
    };

    let sentMails: Array<{ to: string; subject: string; text: string; html: string }> = [];

    beforeEach(() => {
        sentMails = [];
        env.OTP_MODE = 'production';
        env.ENABLE_TEST_OTP = false;
        env.SMTP_HOST = 'smtp.test-relay.local';
        env.SMTP_PORT = 587;
        env.SMTP_SECURE = false;
        env.SMTP_USER = 'test-user';
        env.SMTP_PASS = 'test-pass';
        env.SMTP_FROM_EMAIL = 'verify@thesniff.co';
    });

    afterEach(() => {
        vi.restoreAllMocks();
        env.OTP_MODE = originalSmtp.otpMode;
        env.ENABLE_TEST_OTP = originalSmtp.enableTestOtp;
        env.SMTP_HOST = originalSmtp.host;
        env.SMTP_PORT = originalSmtp.port;
        env.SMTP_SECURE = originalSmtp.secure;
        env.SMTP_USER = originalSmtp.user;
        env.SMTP_PASS = originalSmtp.pass;
        env.SMTP_FROM_EMAIL = originalSmtp.fromEmail;
    });

    afterAll(async () => {
        if (createdCustomerIds.length > 0) {
            await prisma.customerSession.deleteMany({
                where: { customerId: { in: createdCustomerIds } },
            });
            await prisma.refreshToken.deleteMany({
                where: { customerId: { in: createdCustomerIds } },
            });
            await prisma.cart.deleteMany({
                where: { customerId: { in: createdCustomerIds } },
            });
            await prisma.wishlist.deleteMany({
                where: { customerId: { in: createdCustomerIds } },
            });
            await prisma.customer.deleteMany({
                where: { id: { in: createdCustomerIds } },
            });
        }
        if (createdEmails.length > 0) {
            await prisma.pendingRegistration.deleteMany({
                where: { normalizedEmail: { in: createdEmails } },
            });
        }
        await prisma.$disconnect();
    }, 30_000);

    function mockSmtpSuccess() {
        vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
            sendMail: vi.fn(async (mail: { to: string; subject: string; text: string; html: string }) => {
                sentMails.push(mail);
                return { messageId: `<test-${Date.now()}@thesniff.co>` };
            }),
            verify: vi.fn(async () => true),
        } as unknown as ReturnType<typeof nodemailer.createTransport>);
    }

    function extractOtp(text: string): string {
        const match = /OTP Code:\s*([0-9]{6})/.exec(text);
        if (!match) throw new Error('OTP not found in email content');
        return match[1];
    }

    it('generates 6-digit OTPs, hashes with HMAC-SHA256, verifies in constant time, and masks emails', () => {
        const otp = generateSixDigitOtp();
        expect(otp).toMatch(/^[0-9]{6}$/);
        const hash = hashOtp('parent@example.in', otp);
        expect(hash).not.toBe(otp);
        expect(verifyOtpHash('parent@example.in', otp, hash)).toBe(true);
        expect(verifyOtpHash('parent@example.in', '000000', hash)).toBe(otp === '000000');
        expect(maskEmail('aarav.sharma@example.in')).toBe('a****a@example.in');
    });

    it('rejects mobile-only, invalid, missing, unexpected fields and malformed JSON with 400', async () => {
        const cases = [
            { fullName: 'QA User', email: '9876543210', password: 'QaPassword#2026' },
            { fullName: '', email: 'qa@example.in', password: 'QaPassword#2026' },
            { fullName: 'QA User', email: '', password: 'QaPassword#2026' },
            { fullName: 'QA User', email: 'qa@example.in', password: 'short' },
            { fullName: 'QA User', email: 'qa@example.in' },
            {
                fullName: 'QA User',
                email: 'qa@example.in',
                password: 'QaPassword#2026',
                unexpectedAdminFlag: true,
            },
        ];

        for (const payload of cases) {
            const res = await request(app).post('/api/v1/auth/register').send(payload);
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }

        const malformed = await request(app)
            .post('/api/v1/auth/register')
            .set('Content-Type', 'application/json')
            .send('{"fullName": "Broken');
        expect(malformed.status).toBe(400);
        expect(malformed.body.error.code).toBe('INVALID_JSON');

        const badOtpFormats = ['', '12345', 'abcdef', '1234567'];
        for (const otp of badOtpFormats) {
            const res = await request(app)
                .post('/api/v1/auth/verify-otp')
                .send({ email: 'qa@example.in', otp });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
    });

    it('fails safely with 503 when SMTP is unconfigured and 502 when SMTP connection fails, without creating active customer', async () => {
        const unconfiguredEmail = `qa.unconf.${Date.now()}@example.in`;
        createdEmails.push(unconfiguredEmail);
        env.SMTP_HOST = '';
        env.SMTP_PASS = '';

        const unconfRes = await request(app).post('/api/v1/auth/register').send({
            fullName: 'QA Unconfigured SMTP',
            email: unconfiguredEmail,
            password: 'QaPassword#2026',
        });
        expect(unconfRes.status).toBe(503);
        expect(unconfRes.body.error.code).toBe('EMAIL_SERVICE_NOT_CONFIGURED');
        expect(await prisma.customer.findUnique({ where: { email: unconfiguredEmail } })).toBeNull();
        expect(await prisma.pendingRegistration.findUnique({ where: { normalizedEmail: unconfiguredEmail } })).toBeNull();

        // Now configure SMTP host but simulate connection error
        env.SMTP_HOST = 'smtp.unreachable.local';
        env.SMTP_PASS = 'valid-looking-pass';
        vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
            sendMail: vi.fn(async () => {
                throw new Error('ECONNREFUSED 127.0.0.1:587');
            }),
        } as unknown as ReturnType<typeof nodemailer.createTransport>);

        const connFailEmail = `qa.smtpfail.${Date.now()}@example.in`;
        createdEmails.push(connFailEmail);
        const failRes = await request(app).post('/api/v1/auth/register').send({
            fullName: 'QA SMTP Fail',
            email: connFailEmail,
            password: 'QaPassword#2026',
        });
        expect(failRes.status).toBe(502);
        expect(failRes.body.error.code).toBe('EMAIL_DELIVERY_FAILED');
        expect(await prisma.customer.findUnique({ where: { email: connFailEmail } })).toBeNull();
        expect(await prisma.pendingRegistration.findUnique({ where: { normalizedEmail: connFailEmail } })).toBeNull();
    }, 30_000);

    it('completes full email OTP registration -> unverified login rejection -> verify OTP -> session -> logout -> email login -> duplicate rejection', async () => {
        mockSmtpSuccess();
        const email = `qa.otp.full.${Date.now()}@example.in`;
        const password = 'QaPassword#2026';
        createdEmails.push(email);

        // 1. Register -> pending only, sends OTP email, no customer created yet
        const regRes = await request(app).post('/api/v1/auth/register').send({
            fullName: '  QA Verified Parent  ',
            email: email.toUpperCase(),
            password,
            marketingConsent: false,
        });
        expect(regRes.status).toBe(202);
        expect(regRes.body.data.verificationRequired).toBe(true);
        expect(regRes.body.data.otp).toBeUndefined();
        expect(sentMails).toHaveLength(1);
        expect(sentMails[0].subject).toBe('Verify your email address — The Sniff Co.');
        expect(sentMails[0].html).toContain('The Sniff Co.');
        expect(sentMails[0].html).not.toContain(password);

        const otp = extractOtp(sentMails[0].text);
        const pendingRow = await prisma.pendingRegistration.findUnique({
            where: { normalizedEmail: email },
        });
        expect(pendingRow).not.toBeNull();
        expect(pendingRow?.otpHash).not.toBe(otp);
        expect(pendingRow?.passwordHash).not.toBe(password);
        expect(await prisma.customer.findUnique({ where: { email } })).toBeNull();

        // 2. Unverified account attempting login is rejected with 403
        const unverifiedLogin = await request(app).post('/api/v1/auth/login').send({
            identifier: email,
            password,
        });
        expect(unverifiedLogin.status).toBe(403);
        expect(unverifiedLogin.body.error.code).toBe('EMAIL_NOT_VERIFIED');

        // 3. Incorrect OTP attempt fails without activating account
        const wrongOtp = otp === '111111' ? '222222' : '111111';
        const wrongRes = await request(app).post('/api/v1/auth/verify-otp').send({
            email,
            otp: wrongOtp,
        });
        expect(wrongRes.status).toBe(400);
        expect(wrongRes.body.error.code).toBe('OTP_INVALID');
        expect(await prisma.customer.findUnique({ where: { email } })).toBeNull();

        // 4. Verify with valid OTP -> creates active Customer + cookies + concurrent second request rejected!
        const agent = request.agent(app);
        const [verifyA, verifyB] = await Promise.all([
            agent.post('/api/v1/auth/verify-otp').send({ email, otp }),
            request(app).post('/api/v1/auth/verify-otp').send({ email, otp }),
        ]);

        const statuses = [verifyA.status, verifyB.status].sort((a, b) => a - b);
        expect(statuses[0]).toBe(201);
        expect([400, 409]).toContain(statuses[1]);

        const winner = verifyA.status === 201 ? verifyA : verifyB;
        const customerId = winner.body.data.customer.id;
        createdCustomerIds.push(customerId);
        expect(winner.body.data.customer.fullName).toBe('QA Verified Parent');
        expect(winner.body.data.customer.emailVerified).toBe(true);
        expect(winner.body.data.customer.marketingConsent).toBe(false);
        expect(winner.body.data.customer.passwordHash).toBeUndefined();

        // 5. Reusing already-used OTP fails
        const reuseRes = await request(app).post('/api/v1/auth/verify-otp').send({ email, otp });
        expect(reuseRes.status).toBe(400);
        expect(reuseRes.body.error.code).toBe('OTP_ALREADY_USED');

        // 6. Authenticated profile works if agent won, and login works after logout
        const verifyCsrf = verifyA.status === 201 ? (verifyA.body.data.csrfToken || verifyA.headers['x-csrf-token']) : undefined;
        const loginReq = agent.post('/api/v1/auth/login').send({ identifier: email, password });
        if (verifyCsrf) loginReq.set('x-csrf-token', verifyCsrf);
        const loginRes = await loginReq;
        expect(loginRes.status).toBe(200);
        expect(loginRes.body.data.token).toBeUndefined();
        const csrfToken = loginRes.body.data.csrfToken || loginRes.headers['x-csrf-token'];
        expect(csrfToken).toBeTruthy();
        const meRes = await agent.get('/api/v1/customers/me');
        expect(meRes.status).toBe(200);
        expect(meRes.body.data.email).toBe(email);

        // Logout requires valid CSRF token when session cookie is present
        const logoutMissingCsrf = await agent.post('/api/v1/auth/logout');
        expect(logoutMissingCsrf.status).toBe(403);

        await agent.post('/api/v1/auth/logout').set('x-csrf-token', csrfToken);
        const meAfterLogout = await agent.get('/api/v1/customers/me');
        expect(meAfterLogout.status).toBe(401);

        // 7. Duplicate registration for already active account rejected with 409
        const dupRes = await request(app).post('/api/v1/auth/register').send({
            fullName: 'Dup User',
            email,
            password,
        });
        expect(dupRes.status).toBe(409);
    }, 45_000);

    it('enforces OTP expiration, 60s resend cooldown, previous OTP invalidation, 5 resends/hour cap, and 5 failed attempt lockout', async () => {
        mockSmtpSuccess();
        const email = `qa.otp.limits.${Date.now()}@example.in`;
        createdEmails.push(email);

        const reg = await request(app).post('/api/v1/auth/register').send({
            fullName: 'QA Limits User',
            email,
            password: 'QaPassword#2026',
        });
        expect(reg.status).toBe(202);
        const firstOtp = extractOtp(sentMails[0].text);

        // Resend before 60s cooldown is rejected (429)
        const earlyResend = await request(app).post('/api/v1/auth/resend-otp').send({ email });
        expect(earlyResend.status).toBe(429);
        expect(earlyResend.body.error.code).toBe('OTP_RESEND_COOLDOWN');

        // Simulate elapsed cooldown -> resend succeeds and invalidates firstOtp
        await prisma.pendingRegistration.update({
            where: { normalizedEmail: email },
            data: { lastResendAt: new Date(Date.now() - 65 * 1000) },
        });
        const resendOk = await request(app).post('/api/v1/auth/resend-otp').send({ email });
        expect(resendOk.status).toBe(200);
        expect(sentMails).toHaveLength(2);
        const secondOtp = extractOtp(sentMails[1].text);

        // Old OTP must fail if different from new OTP
        if (firstOtp !== secondOtp) {
            const oldOtpTry = await request(app).post('/api/v1/auth/verify-otp').send({
                email,
                otp: firstOtp,
            });
            expect(oldOtpTry.status).toBe(400);
        }

        // Expired OTP must return 400 OTP_EXPIRED
        await prisma.pendingRegistration.update({
            where: { normalizedEmail: email },
            data: { otpExpiresAt: new Date(Date.now() - 5 * 1000) },
        });
        const expiredTry = await request(app).post('/api/v1/auth/verify-otp').send({
            email,
            otp: secondOtp,
        });
        expect(expiredTry.status).toBe(400);
        expect(expiredTry.body.error.code).toBe('OTP_EXPIRED');

        // Refresh expiry cleanly -> 5 failed attempts invalidates OTP
        await prisma.pendingRegistration.update({
            where: { normalizedEmail: email },
            data: {
                otpExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
                failedAttempts: 0,
                status: 'PENDING',
            },
        });
        const wrongOtp = secondOtp === '999999' ? '888888' : '999999';
        for (let i = 1; i <= 4; i += 1) {
            const attempt = await request(app).post('/api/v1/auth/verify-otp').send({
                email,
                otp: wrongOtp,
            });
            expect(attempt.status).toBe(400);
            expect(attempt.body.error.code).toBe('OTP_INVALID');
        }
        const fifthAttempt = await request(app).post('/api/v1/auth/verify-otp').send({
            email,
            otp: wrongOtp,
        });
        expect(fifthAttempt.status).toBe(429);
        expect(fifthAttempt.body.error.code).toBe('OTP_MAX_ATTEMPTS');

        // Valid secondOtp must now be rejected because OTP is invalidated!
        const validAfterLock = await request(app).post('/api/v1/auth/verify-otp').send({
            email,
            otp: secondOtp,
        });
        expect(validAfterLock.status).toBe(429);

        // Simulate 5 resends in the last hour -> 6th resend rejected (429 OTP_RESEND_LIMIT)
        await prisma.pendingRegistration.update({
            where: { normalizedEmail: email },
            data: {
                resendCount: 5,
                resendWindowStart: new Date(),
                lastResendAt: new Date(Date.now() - 65 * 1000),
            },
        });
        const maxResend = await request(app).post('/api/v1/auth/resend-otp').send({ email });
        expect(maxResend.status).toBe(429);
        expect(maxResend.body.error.code).toBe('OTP_RESEND_LIMIT');
    }, 45_000);

    it('handles database unavailability cleanly with 503 DATABASE_UNAVAILABLE during registration', async () => {
        const originalDeleteMany = prisma.pendingRegistration.deleteMany.bind(prisma.pendingRegistration);
        prisma.pendingRegistration.deleteMany = (async () => {
            throw Object.assign(new Error('Can not reach database server'), { code: 'P1001' });
        }) as typeof prisma.pendingRegistration.deleteMany;
        try {
            const res = await request(app).post('/api/v1/auth/register').send({
                fullName: 'QA DB Fail',
                email: `qa.dbfail.${Date.now()}@example.in`,
                password: 'QaPassword#2026',
            });
            expect(res.status).toBe(503);
            expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
        } finally {
            prisma.pendingRegistration.deleteMany = originalDeleteMany;
        }
    });

    it('supports development OTP mode: bypasses Nodemailer, returns devOtp, saves mobile number, verifies, and supports dev resend', async () => {
        env.OTP_MODE = 'development';
        env.ENABLE_TEST_OTP = true;
        env.SMTP_HOST = ''; // Unconfigured SMTP must NOT block dev mode
        env.SMTP_PASS = '';

        const devEmail = `qa.devotp.${Date.now()}@example.in`;
        const devPhone = `9${Math.floor(100000000 + Math.random() * 900000000)}`;
        createdEmails.push(devEmail);

        // 1. Register with mobile number and dev mode enabled
        const regRes = await request(app).post('/api/v1/auth/register').send({
            fullName: 'QA Dev Mode Parent',
            email: devEmail,
            phone: devPhone,
            password: 'QaPassword#2026',
            marketingConsent: true,
        });

        expect(regRes.status).toBe(202);
        expect(regRes.body.data.verificationRequired).toBe(true);
        expect(regRes.body.data.isDevMode).toBe(true);
        expect(regRes.body.data.devOtp).toMatch(/^[0-9]{6}$/);
        expect(sentMails).toHaveLength(0); // Nodemailer must NOT be called in dev mode

        const generatedOtp = regRes.body.data.devOtp;

        // Verify phone was saved to PendingRegistration
        const pending = await prisma.pendingRegistration.findUnique({
            where: { normalizedEmail: devEmail },
        });
        expect(pending).not.toBeNull();
        expect(pending?.phone).toBe(devPhone);
        expect(pending?.fullName).toBe('QA Dev Mode Parent');

        // 2. Resend in dev mode returns fresh devOtp without calling SMTP
        await prisma.pendingRegistration.update({
            where: { normalizedEmail: devEmail },
            data: { lastResendAt: new Date(Date.now() - 65 * 1000) },
        });
        const resendRes = await request(app).post('/api/v1/auth/resend-otp').send({ email: devEmail });
        expect(resendRes.status).toBe(200);
        expect(resendRes.body.data.isDevMode).toBe(true);
        expect(resendRes.body.data.devOtp).toMatch(/^[0-9]{6}$/);
        expect(sentMails).toHaveLength(0);

        const freshOtp = resendRes.body.data.devOtp;

        // 3. Verify using the fresh devOtp
        const verifyRes = await request(app).post('/api/v1/auth/verify-otp').send({
            email: devEmail,
            otp: freshOtp,
        });

        expect(verifyRes.status).toBe(201);
        expect(verifyRes.body.data.customer.fullName).toBe('QA Dev Mode Parent');
        expect(verifyRes.body.data.customer.email).toBe(devEmail);
        expect(verifyRes.body.data.customer.phone).toBe(devPhone);
        createdCustomerIds.push(verifyRes.body.data.customer.id);
    }, 45_000);
});
