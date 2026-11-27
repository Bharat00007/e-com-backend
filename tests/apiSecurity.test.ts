import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('API security & route protection', () => {
  it('GET /health returns 200 with security headers', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('POST /api/v1/auth/register rejects invalid payload with 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ fullName: 'A', email: 'not-an-email', password: '123' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('protects customer, checkout, and admin endpoints with 401 when unauthenticated', async () => {
    const [profileRes, ordersRes, wishlistRes, checkoutRes, adminRes] = await Promise.all([
      request(app).get('/api/v1/customers/me'),
      request(app).get('/api/v1/orders'),
      request(app).get('/api/v1/wishlist'),
      request(app).post('/api/v1/checkout/create-order').send({}),
      request(app).get('/api/v1/admin/orders'),
    ]);

    expect(profileRes.status).toBe(401);
    expect(ordersRes.status).toBe(401);
    expect(wishlistRes.status).toBe(401);
    expect(checkoutRes.status).toBe(401);
    expect(adminRes.status).toBe(401);
  });
});
