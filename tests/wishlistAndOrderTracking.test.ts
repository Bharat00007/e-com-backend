import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { signAccessToken } from '../src/utils/jwt';

vi.setConfig({ testTimeout: 30000 });

const app = createApp();

describe('Wishlist and Order Tracking Comprehensive Test Suite', () => {
  let customerAId: string;
  let customerAToken: string;
  let customerBId: string;
  let customerBToken: string;
  let adminId: string;
  let adminToken: string;
  let sampleProductId: string;
  let sampleVariantId: string;
  let createdOrderId: string;

  beforeAll(async () => {
    // 1. Create Customer A
    const passwordHash = await bcrypt.hash('TestPass123!', 8);
    const customerA = await prisma.customer.create({
      data: {
        fullName: 'Wishlist Tester A',
        email: `wishlist.a.${Date.now()}@thesniff.co`,
        passwordHash,
        emailVerified: true,
      },
    });
    customerAId = customerA.id;
    customerAToken = signAccessToken({ sub: customerA.id, type: 'customer' });

    // 2. Create Customer B
    const customerB = await prisma.customer.create({
      data: {
        fullName: 'Wishlist Tester B',
        email: `wishlist.b.${Date.now()}@thesniff.co`,
        passwordHash,
        emailVerified: true,
      },
    });
    customerBId = customerB.id;
    customerBToken = signAccessToken({ sub: customerB.id, type: 'customer' });

    // 3. Ensure an active Admin User
    let admin = await prisma.adminUser.findFirst({ where: { status: 'ACTIVE' } });
    if (!admin) {
      admin = await prisma.adminUser.create({
        data: {
          fullName: 'Test Operations Admin',
          email: `admin.test.${Date.now()}@thesniff.co`,
          passwordHash,
          role: 'SUPER_ADMIN',
        },
      });
    }
    adminId = admin.id;
    adminToken = signAccessToken({ sub: admin.id, type: 'admin', role: admin.role });

    // 4. Retrieve a valid product
    const product = await prisma.product.findFirst({
      where: { status: 'ACTIVE' },
      include: { variants: true },
    });
    if (!product || product.variants.length === 0) {
      throw new Error('No active products with variants in database');
    }
    sampleProductId = product.id;
    sampleVariantId = product.variants[0].id;
  }, 30_000);

  afterAll(async () => {
    if (createdOrderId) {
      await prisma.shipment.deleteMany({ where: { orderId: createdOrderId } });
      await prisma.payment.deleteMany({ where: { orderId: createdOrderId } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: createdOrderId } });
      await prisma.orderItem.deleteMany({ where: { orderId: createdOrderId } });
      await prisma.order.deleteMany({ where: { id: createdOrderId } });
    }

    if (customerAId) {
      await prisma.wishlistItem.deleteMany({ where: { wishlist: { customerId: customerAId } } });
      await prisma.wishlist.deleteMany({ where: { customerId: customerAId } });
      await prisma.customer.deleteMany({ where: { id: customerAId } });
    }

    if (customerBId) {
      await prisma.wishlistItem.deleteMany({ where: { wishlist: { customerId: customerBId } } });
      await prisma.wishlist.deleteMany({ where: { customerId: customerBId } });
      await prisma.customer.deleteMany({ where: { id: customerBId } });
    }

    await prisma.$disconnect();
  }, 30_000);

  // ==========================================
  // PART 1: WISHLIST TESTS
  // ==========================================

  it('GET /api/v1/wishlist requires authentication (401)', async () => {
    const res = await request(app).get('/api/v1/wishlist');
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/wishlist returns empty array initially for Customer A', async () => {
    const res = await request(app)
      .get('/api/v1/wishlist')
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.items).toEqual([]);
  });

  it('POST /api/v1/wishlist/:productId adds product to Customer A wishlist', async () => {
    const res = await request(app)
      .post(`/api/v1/wishlist/${sampleProductId}`)
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.added).toBe(true);
    expect(res.body.data.productId).toBe(sampleProductId);
  });

  it('Re-adding the same product does not duplicate wishlist entry', async () => {
    const res = await request(app)
      .post(`/api/v1/wishlist/${sampleProductId}`)
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(res.status).toBe(201);

    const getRes = await request(app)
      .get('/api/v1/wishlist')
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.items.length).toBe(1);
    expect(getRes.body.data.items[0].productId).toBe(sampleProductId);
    expect(getRes.body.data.items[0].product.name).toBeDefined();
  });

  it('POST /api/v1/wishlist/toggle removes product when already in wishlist', async () => {
    const res = await request(app)
      .post('/api/v1/wishlist/toggle')
      .set('Authorization', `Bearer ${customerAToken}`)
      .send({ productId: sampleProductId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.added).toBe(false);

    const checkRes = await request(app)
      .get('/api/v1/wishlist')
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(checkRes.body.data.items.length).toBe(0);
  });

  it('POST /api/v1/wishlist/merge successfully merges guest product IDs on login', async () => {
    const res = await request(app)
      .post('/api/v1/wishlist/merge')
      .set('Authorization', `Bearer ${customerAToken}`)
      .send({ productIds: [sampleProductId] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.mergedCount).toBe(1);
    expect(res.body.data.productIds).toContain(sampleProductId);
  });

  it('DELETE /api/v1/wishlist/:productId removes product from wishlist', async () => {
    const res = await request(app)
      .delete(`/api/v1/wishlist/${sampleProductId}`)
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.removed).toBe(true);

    const checkRes = await request(app)
      .get('/api/v1/wishlist')
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(checkRes.body.data.items.length).toBe(0);
  });

  it('Customer B cannot see Customer A wishlist (strict isolation)', async () => {
    // Add product to Customer A
    await request(app)
      .post(`/api/v1/wishlist/${sampleProductId}`)
      .set('Authorization', `Bearer ${customerAToken}`);

    // Verify Customer B sees 0 items
    const resB = await request(app)
      .get('/api/v1/wishlist')
      .set('Authorization', `Bearer ${customerBToken}`);

    expect(resB.status).toBe(200);
    expect(resB.body.data.items.length).toBe(0);
  });

  // ==========================================
  // PART 2: ORDER TRACKING TESTS
  // ==========================================

  it('Creates a test COD order and starts lifecycle at PENDING', async () => {
    const orderNumber = `TSCTest-${Date.now().toString().slice(-6)}`;
    const order = await prisma.order.create({
      data: {
        orderNumber,
        customerId: customerAId,
        customerNameSnapshot: 'Wishlist Tester A',
        customerEmailSnapshot: 'tester.a@thesniff.co',
        customerPhoneSnapshot: '9876543210',
        shippingAddressSnapshot: {
          recipientName: 'Wishlist Tester A',
          phone: '9876543210',
          addressLine1: 'B-101 Green Heights',
          addressLine2: 'Bandra West',
          city: 'Mumbai',
          state: 'Maharashtra',
          pincode: '400050',
        },
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentMethod: 'COD',
        subtotalAmount: 799,
        shippingCharge: 0,
        totalAmount: 799,
        items: {
          create: [
            {
              variantId: sampleVariantId,
              productName: 'Natural Clumping Cat Litter',
              packSizeLabel: '5 kg',
              sku: 'CAT-LIT-5KG',
              unitPrice: 799,
              quantity: 1,
              lineTotal: 799,
            },
          ],
        },
        history: {
          create: {
            status: 'PENDING',
            note: 'Order placed via Cash on Delivery',
            updatedBy: 'Customer',
          },
        },
        shipment: {
          create: {
            carrier: 'Delhivery Express',
            status: 'PENDING',
          },
        },
      },
    });

    createdOrderId = order.id;
    expect(order.id).toBeDefined();
    expect(order.status).toBe('PENDING');
    expect(order.paymentStatus).toBe('PENDING');
  });

  it('GET /api/v1/orders/:id/tracking returns valid lifecycle steps for Customer A', async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${createdOrderId}/tracking`)
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(data.currentStatus).toBe('PENDING');
    expect(data.paymentStatus).toBe('PENDING');
    expect(data.paymentMethod).toBe('COD');
    expect(data.steps.length).toBe(6);

    // Initial step (Order Placed) should be active/current
    expect(data.steps[0].status).toBe('PENDING');
    expect(data.steps[0].isCurrent).toBe(true);

    // Future steps must NOT be completed
    expect(data.steps[1].isCompleted).toBe(false);
    expect(data.steps[5].isCompleted).toBe(false);
  });

  it('Customer B cannot view Customer A order tracking (IDOR prevention - 404)', async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${createdOrderId}/tracking`)
      .set('Authorization', `Bearer ${customerBToken}`);

    expect(res.status).toBe(404);
  });

  it('Admin PATCH /api/v1/admin/orders/:id/status rejects invalid jump transition (400)', async () => {
    // Attempt illegal transition from PENDING directly to DELIVERED
    const res = await request(app)
      .patch(`/api/v1/admin/orders/${createdOrderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DELIVERED' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid status transition');
  });

  it('Admin PATCH /api/v1/admin/orders/:id/status advances to CONFIRMED with notes', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/orders/${createdOrderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'CONFIRMED',
        note: 'Order confirmed and allocated for fulfillment',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('CONFIRMED');
  });

  it('Admin advances order to SHIPPED with carrier tracking info', async () => {
    // 1. Advance to PACKED
    await request(app)
      .patch(`/api/v1/admin/orders/${createdOrderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'PACKED', note: 'Securely packaged in heavy duty box' });

    // 2. Advance to SHIPPED with Delhivery tracking number
    const trackingNo = 'DEL9988776655';
    const res = await request(app)
      .patch(`/api/v1/admin/orders/${createdOrderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'SHIPPED',
        carrier: 'Delhivery Express',
        trackingNumber: trackingNo,
        note: 'Dispatched via Delhivery Surface Express',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SHIPPED');
    expect(res.body.data.shipment.carrier).toBe('Delhivery Express');
    expect(res.body.data.shipment.trackingNumber).toBe(trackingNo);
    expect(res.body.data.shipment.carrierTrackingUrl).toContain('delhivery.com');
  });

  it('Customer tracking reflects SHIPPED status with real carrier URL', async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${createdOrderId}/tracking`)
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.currentStatus).toBe('SHIPPED');
    expect(data.shipment.trackingNumber).toBe('DEL9988776655');
    expect(data.shipment.carrierTrackingUrl).toContain('https://www.delhivery.com/track/package/DEL9988776655');

    // Steps: PENDING, CONFIRMED, PACKED should be completed
    expect(data.steps[0].isCompleted).toBe(true);
    expect(data.steps[1].isCompleted).toBe(true);
    expect(data.steps[2].isCompleted).toBe(true);
    expect(data.steps[3].isCurrent).toBe(true);
    expect(data.steps[5].isCompleted).toBe(false);
  });

  it('Admin delivers order and confirms COD payment collected (CAPTURED)', async () => {
    // 1. Advance to OUT_FOR_DELIVERY
    await request(app)
      .patch(`/api/v1/admin/orders/${createdOrderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'OUT_FOR_DELIVERY', note: 'Out with delivery courier' });

    // 2. Deliver and mark paymentStatus as CAPTURED
    const res = await request(app)
      .patch(`/api/v1/admin/orders/${createdOrderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        status: 'DELIVERED',
        paymentStatus: 'CAPTURED',
        note: 'Delivered to customer. Cash collected ₹799 in full.',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DELIVERED');
    expect(res.body.data.paymentStatus).toBe('CAPTURED');

    // Customer tracking shows DELIVERED as final step
    const trackRes = await request(app)
      .get(`/api/v1/orders/${createdOrderId}/tracking`)
      .set('Authorization', `Bearer ${customerAToken}`);

    expect(trackRes.status).toBe(200);
    expect(trackRes.body.data.currentStatus).toBe('DELIVERED');
    expect(trackRes.body.data.paymentStatus).toBe('CAPTURED');
    expect(trackRes.body.data.steps[5].isCurrent).toBe(true);
  });
});
