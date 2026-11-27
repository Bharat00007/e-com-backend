import { describe, it, expect, afterAll, vi } from 'vitest';
import request from 'supertest';
import nodemailer from 'nodemailer';
import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { env } from '../src/config/env';

const app = createApp();

describe('Storefront workflows, COD checkout, stock checks & authorization', () => {
    const createdCustomerIds: string[] = [];
    const createdOrderIds: string[] = [];
    const createdEmails: string[] = [];

    afterAll(async () => {
        vi.restoreAllMocks();
        if (createdOrderIds.length > 0) {
            await prisma.shipment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
            await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
            await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: createdOrderIds } } });
            await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
            await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
        }
        if (createdCustomerIds.length > 0) {
            await prisma.refreshToken.deleteMany({ where: { customerId: { in: createdCustomerIds } } });
            await prisma.cart.deleteMany({ where: { customerId: { in: createdCustomerIds } } });
            await prisma.wishlist.deleteMany({ where: { customerId: { in: createdCustomerIds } } });
            await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
        }
        if (createdEmails.length > 0) {
            await prisma.pendingRegistration.deleteMany({
                where: { normalizedEmail: { in: createdEmails } },
            });
        }
        await prisma.$disconnect();
    }, 30_000);

    it('GET /health verifies PostgreSQL database connection', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.database).toBe('connected');
    }, 15_000);

    it('GET /api/v1/cart returns empty cart for fresh guest without DB error', async () => {
        const res = await request(app).get('/api/v1/cart');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.items).toEqual([]);
        expect(res.body.data.totals.totalAmount).toBe(0);
    });

    it('enforces empty cart checkout, COD-only guard, stock check, COD order creation, IDOR isolation & cancellation stock restoration', async () => {
        const agentA = request.agent(app);
        const agentB = request.agent(app);

        env.SMTP_HOST = 'smtp.test-relay.local';
        env.SMTP_USER = 'test-user';
        env.SMTP_PASS = 'test-pass';
        env.SMTP_FROM_EMAIL = 'verify@thesniff.co';

        let lastOtp = '';
        vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
            sendMail: vi.fn(async (mail: { text: string }) => {
                const match = /OTP Code:\s*([0-9]{6})/.exec(mail.text);
                if (match) lastOtp = match[1];
                return { messageId: `<wf-${Date.now()}@thesniff.co>` };
            }),
        } as unknown as ReturnType<typeof nodemailer.createTransport>);

        const ts = Date.now();
        const emailA = `qa.wf.a.${ts}@example.in`;
        const emailB = `qa.wf.b.${ts}@example.in`;
        createdEmails.push(emailA, emailB);

        const productsBeforeAuth = await agentA.get('/api/v1/products');
        expect(productsBeforeAuth.status).toBe(200);
        const preVariant = productsBeforeAuth.body.data[0].variants[0];

        // Guest adds 1 item BEFORE registering -> guest cart must survive email OTP verification!
        const guestAdd = await agentA.post('/api/v1/cart/items').send({
            variantId: preVariant.id,
            quantity: 1,
            isSubscription: false,
        });
        expect(guestAdd.status).toBe(201);

        const regAInit = await agentA.post('/api/v1/auth/register').send({
            fullName: 'QA Workflow Parent A',
            email: emailA,
            password: 'QaPassword#2026',
            marketingConsent: false,
        });
        expect(regAInit.status).toBe(202);
        const otpA = regAInit.body.data.devOtp || lastOtp;
        const regA = await agentA.post('/api/v1/auth/verify-otp').send({ email: emailA, otp: otpA });
        expect(regA.status).toBe(201);
        createdCustomerIds.push(regA.body.data.customer.id);

        // Guest cart item must be merged & preserved immediately upon OTP verification
        const mergedCart = await agentA.get('/api/v1/cart');
        expect(mergedCart.status).toBe(200);
        expect(mergedCart.body.data.items).toHaveLength(1);
        await agentA.delete(`/api/v1/cart/items/${mergedCart.body.data.items[0].id}`);

        const regBInit = await agentB.post('/api/v1/auth/register').send({
            fullName: 'QA Workflow Parent B',
            email: emailB,
            password: 'QaPassword#2026',
            marketingConsent: false,
        });
        expect(regBInit.status).toBe(202);
        const otpB = regBInit.body.data.devOtp || lastOtp;
        const regB = await agentB.post('/api/v1/auth/verify-otp').send({ email: emailB, otp: otpB });
        expect(regB.status).toBe(201);
        createdCustomerIds.push(regB.body.data.customer.id);

        // 1. Customer cannot access admin routes (401/403)
        const adminAttempt = await agentA.get('/api/v1/admin/orders');
        expect([401, 403]).toContain(adminAttempt.status);

        // 2. Empty cart checkout is rejected with 400
        const address = {
            recipientName: 'QA Workflow Parent A',
            phone: '9876543210',
            addressLine1: 'Flat 101, Pet Haven',
            addressLine2: 'MG Road',
            city: 'Pune',
            state: 'Maharashtra',
            pincode: '411001',
        };
        const emptyCheckout = await agentA.post('/api/v1/checkout/create-order').send({
            contactEmail: `qa.wf.a.${ts}@example.in`,
            contactPhone: '9876543210',
            shippingAddress: address,
            shippingMethod: 'standard',
            paymentMethod: 'COD',
        });
        expect(emptyCheckout.status).toBe(400);

        // 3. Look up real product variant and verify over-stock quantity rejection
        const productsRes = await agentA.get('/api/v1/products');
        expect(productsRes.status).toBe(200);
        const product = productsRes.body.data[0];
        const variant = product.variants[0];
        const initialStock: number = variant.stockQuantity;

        const overMaxRes = await agentA.post('/api/v1/cart/items').send({
            variantId: variant.id,
            quantity: 25,
            isSubscription: false,
        });
        expect(overMaxRes.status).toBe(400);

        // 4. Add 1 unit to cart as Customer A
        const addRes = await agentA.post('/api/v1/cart/items').send({
            variantId: variant.id,
            quantity: 1,
            isSubscription: false,
        });
        expect(addRes.status).toBe(201);
        expect(addRes.body.data.items).toHaveLength(1);

        // 5. Reject UPI/CARD when Razorpay keys are unconfigured (503)
        const upiRes = await agentA.post('/api/v1/checkout/create-order').send({
            idempotencyKey: `idem-upi-${ts}`,
            contactEmail: `qa.wf.a.${ts}@example.in`,
            contactPhone: '9876543210',
            shippingAddress: address,
            shippingMethod: 'standard',
            paymentMethod: 'UPI',
        });
        expect(upiRes.status).toBe(503);
        expect(upiRes.body.error.code).toBe('PAYMENT_GATEWAY_NOT_CONFIGURED');

        // 6. Place real COD order -> CONFIRMED, paymentMethod=COD, paymentStatus=PENDING, unique SNC- order number
        const idemKey = `idem-cod-${ts}`;
        const codRes = await agentA.post('/api/v1/checkout/create-order').send({
            idempotencyKey: idemKey,
            contactEmail: `qa.wf.a.${ts}@example.in`,
            contactPhone: '9876543210',
            shippingAddress: address,
            shippingMethod: 'standard',
            paymentMethod: 'COD',
        });
        expect(codRes.status).toBe(201);
        const createdOrder = codRes.body.data;
        createdOrderIds.push(createdOrder.id);

        expect(createdOrder.orderNumber).toMatch(/^SNC-\d+$/);
        expect(createdOrder.paymentMethod).toBe('COD');
        expect(createdOrder.paymentStatus).toBe('PENDING');
        expect(createdOrder.status).toBe('CONFIRMED');

        // 7. Customer B cannot view Customer A's order OR hijack idempotency key OR create payment gateway order for Customer A's order
        const crossOrderRead = await agentB.get(`/api/v1/orders/${createdOrder.orderNumber}`);
        expect(crossOrderRead.status).toBe(404);

        const crossIdemAttempt = await agentB.post('/api/v1/checkout/create-order').send({
            idempotencyKey: idemKey,
            contactEmail: `qa.wf.b.${ts}@example.in`,
            contactPhone: '9876543211',
            shippingAddress: address,
            shippingMethod: 'standard',
            paymentMethod: 'COD',
        });
        expect(crossIdemAttempt.status).toBe(409);

        const crossPaymentAttempt = await agentB
            .post('/api/v1/payments/create-gateway-order')
            .send({ orderId: createdOrder.id });
        expect(crossPaymentAttempt.status).toBe(403);

        // 8. Verify stock decremented by 1 and cancel restores stock
        const afterOrderVariant = await prisma.productVariant.findUnique({ where: { id: variant.id } });
        expect(afterOrderVariant?.stockQuantity).toBe(initialStock - 1);

        const cancelRes = await agentA.post(`/api/v1/orders/${createdOrder.id}/cancel`);
        expect(cancelRes.status).toBe(200);
        expect(cancelRes.body.data.status).toBe('CANCELLED');

        const afterCancelVariant = await prisma.productVariant.findUnique({ where: { id: variant.id } });
        expect(afterCancelVariant?.stockQuantity).toBe(initialStock);
    }, 45_000);
});
