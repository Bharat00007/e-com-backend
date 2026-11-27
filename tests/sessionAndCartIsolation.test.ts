import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { hashToken } from '../src/utils/jwt';

const app = createApp();

describe('Server Session Security, Guest/Customer Isolation & Idempotent Merge', () => {
  let customerA: { id: string; email: string };
  let customerB: { id: string; email: string };
  let variant1Id: string;
  let variant2Id: string;
  const createdGuestSessionIds: string[] = [];

  beforeAll(async () => {
    const pwHash = await bcrypt.hash('IsolationPass@2026', 8);
    const ts = Date.now();
    const a = await prisma.customer.create({
      data: {
        fullName: 'Isolation Customer A',
        email: `iso.a.${ts}@example.in`,
        passwordHash: pwHash,
        emailVerified: true,
      },
    });
    const b = await prisma.customer.create({
      data: {
        fullName: 'Isolation Customer B',
        email: `iso.b.${ts}@example.in`,
        passwordHash: pwHash,
        emailVerified: true,
      },
    });
    customerA = { id: a.id, email: a.email! };
    customerB = { id: b.id, email: b.email! };

    const products = await prisma.product.findMany({
      where: { status: 'ACTIVE' },
      include: { variants: { where: { isAvailable: true } } },
      take: 2,
    });
    variant1Id = products[0].variants[0].id;
    variant2Id = (products[1]?.variants[0] ?? products[0].variants[1] ?? products[0].variants[0]).id;
  }, 30_000);

  afterAll(async () => {
    await prisma.customerSession.deleteMany({
      where: { customerId: { in: [customerA.id, customerB.id] } },
    });
    await prisma.cart.deleteMany({
      where: { customerId: { in: [customerA.id, customerB.id] } },
    });
    if (createdGuestSessionIds.length > 0) {
      await prisma.cart.deleteMany({
        where: { guestSessionId: { in: createdGuestSessionIds } },
      });
      await prisma.guestSession.deleteMany({
        where: { id: { in: createdGuestSessionIds } },
      });
    }
    await prisma.guestSession.deleteMany({
      where: { consumedByCustomerId: { in: [customerA.id, customerB.id] } },
    });
    await prisma.customer.deleteMany({
      where: { id: { in: [customerA.id, customerB.id] } },
    });
    await prisma.$disconnect();
  }, 30_000);

  it('isolates independent guest sessions and rejects arbitrary frontend guest headers', async () => {
    const guest1 = request.agent(app);
    const guest2 = request.agent(app);

    // 1. Initialize guest sessions via /auth/session
    const s1 = await guest1.get('/api/v1/auth/session');
    expect(s1.status).toBe(200);
    expect(s1.body.data.authenticated).toBe(false);
    expect(s1.body.data.hasGuestSession).toBe(true);
    const csrf1 = s1.body.data.csrfToken;

    const s2 = await guest2.get('/api/v1/auth/session');
    expect(s2.status).toBe(200);
    expect(s2.body.data.authenticated).toBe(false);
    const csrf2 = s2.body.data.csrfToken;

    // Track guest sessions for cleanup
    const g1Cookie = (s1.headers['set-cookie'] as unknown as string[])?.find((c) => c.startsWith('gsid='))?.split(';')[0].split('=')[1];
    const g2Cookie = (s2.headers['set-cookie'] as unknown as string[])?.find((c) => c.startsWith('gsid='))?.split(';')[0].split('=')[1];
    expect(g1Cookie).toBeTruthy();
    expect(g2Cookie).toBeTruthy();
    expect(g1Cookie).not.toBe(g2Cookie);

    const dbG1 = await prisma.guestSession.findUnique({ where: { tokenHash: hashToken(g1Cookie!) } });
    const dbG2 = await prisma.guestSession.findUnique({ where: { tokenHash: hashToken(g2Cookie!) } });
    expect(dbG1).not.toBeNull();
    expect(dbG2).not.toBeNull();
    createdGuestSessionIds.push(dbG1!.id, dbG2!.id);

    // 2. Guest 1 adds variant1; Guest 2 cannot see Guest 1's item even if spoofing header
    const add1 = await guest1
      .post('/api/v1/cart/items')
      .set('x-csrf-token', csrf1)
      .send({ variantId: variant1Id, quantity: 1, isSubscription: false });
    expect(add1.status).toBe(201);
    expect(add1.body.data.items).toHaveLength(1);

    const g2CartWithSpoof = await guest2
      .get('/api/v1/cart')
      .set('x-guest-cart-token', dbG1!.id);
    expect(g2CartWithSpoof.status).toBe(200);
    expect(g2CartWithSpoof.body.data.items).toHaveLength(0);

    // 3. Guest 2 adds variant2 independently
    const add2 = await guest2
      .post('/api/v1/cart/items')
      .set('x-csrf-token', csrf2)
      .send({ variantId: variant2Id, quantity: 2, isSubscription: false });
    expect(add2.status).toBe(201);
    expect(add2.body.data.items).toHaveLength(1);
    expect(add2.body.data.items[0].variantId).toBe(variant2Id);
  }, 45_000);

  it('enforces CSRF Origin and token validation, rotates PostgreSQL session on login, merges idempotently without doubling, and isolates Customer A vs Customer B', async () => {
    const agentA = request.agent(app);
    const agentB = request.agent(app);

    // 1. CSRF Origin rejection test
    const badOrigin = await agentA
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil-attacker.example.com')
      .send({ identifier: customerA.email, password: 'IsolationPass@2026' });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('CSRF_ORIGIN_DENIED');

    // 2. Guest A initiates session and adds 1 item
    const initA = await agentA.get('/api/v1/auth/session');
    let csrfA = initA.body.data.csrfToken;
    const addGuestA = await agentA
      .post('/api/v1/cart/items')
      .set('x-csrf-token', csrfA)
      .send({ variantId: variant1Id, quantity: 1, isSubscription: false });
    expect(addGuestA.status).toBe(201);

    // 3. Login Customer A -> creates CustomerSession in DB, sets HttpOnly sid cookie, merges ONLY Guest A's cart
    const loginA = await agentA
      .post('/api/v1/auth/login')
      .set('x-csrf-token', csrfA)
      .send({ identifier: customerA.email, password: 'IsolationPass@2026' });
    expect(loginA.status).toBe(200);
    expect(loginA.body.data.token).toBeUndefined();
    expect(loginA.body.data.accessToken).toBeUndefined();
    csrfA = loginA.body.data.csrfToken;

    const sidA1 = (loginA.headers['set-cookie'] as unknown as string[])?.find((c) => c.startsWith('sid='))?.split(';')[0].split('=')[1];
    expect(sidA1).toBeTruthy();

    // Verify PostgreSQL stored SHA-256 hash (not raw token)
    const dbSess1 = await prisma.customerSession.findUnique({ where: { tokenHash: hashToken(sidA1!) } });
    expect(dbSess1).not.toBeNull();
    expect(dbSess1?.customerId).toBe(customerA.id);
    expect(dbSess1?.revokedAt).toBeNull();

    // Verify Guest cart has 1 item and repeated /cart/merge NEVER doubles quantity (idempotency!)
    const mergeAgain1 = await agentA
      .post('/api/v1/cart/merge')
      .set('x-csrf-token', csrfA)
      .send({ items: [{ variantId: variant1Id, quantity: 5 }] }); // ignored malicious/stale client items!
    expect(mergeAgain1.status).toBe(200);
    expect(mergeAgain1.body.data.items).toHaveLength(1);
    expect(mergeAgain1.body.data.items[0].quantity).toBe(1);

    // 4. Verify CSRF missing token is rejected on authenticated state-change
    const missingCsrfRes = await agentA
      .post('/api/v1/cart/items')
      .send({ variantId: variant1Id, quantity: 1 });
    expect(missingCsrfRes.status).toBe(403);
    expect(missingCsrfRes.body.error.code).toBe('CSRF_TOKEN_INVALID');

    // 5. Re-login / session rotation revokes old CustomerSession and issues a brand new sid
    const loginA2 = await agentA
      .post('/api/v1/auth/login')
      .set('x-csrf-token', csrfA)
      .send({ identifier: customerA.email, password: 'IsolationPass@2026' });
    expect(loginA2.status).toBe(200);
    csrfA = loginA2.body.data.csrfToken;
    const sidA2 = (loginA2.headers['set-cookie'] as unknown as string[])?.find((c) => c.startsWith('sid='))?.split(';')[0].split('=')[1];
    expect(sidA2).toBeTruthy();
    expect(sidA2).not.toBe(sidA1);

    const dbSess1AfterRotate = await prisma.customerSession.findUnique({ where: { id: dbSess1!.id } });
    expect(dbSess1AfterRotate?.revokedAt).not.toBeNull();

    // Old sid token rejected immediately
    const oldCookieRes = await request(app)
      .get('/api/v1/customers/me')
      .set('Cookie', `sid=${sidA1}`);
    expect(oldCookieRes.status).toBe(401);

    // 6. Customer B logs in separately -> sees empty cart (ZERO cross-customer leakage!)
    const loginB = await agentB
      .post('/api/v1/auth/login')
      .send({ identifier: customerB.email, password: 'IsolationPass@2026' });
    expect(loginB.status).toBe(200);
    const csrfB = loginB.body.data.csrfToken;

    const cartB = await agentB.get('/api/v1/cart');
    expect(cartB.status).toBe(200);
    expect(cartB.body.data.items).toHaveLength(0);

    // Customer B attempts to delete Customer A's CartItem ID -> rejected / zero effect on Customer A
    const itemAId = mergeAgain1.body.data.items[0].id;
    await agentB.delete(`/api/v1/cart/items/${itemAId}`).set('x-csrf-token', csrfB);

    const cartAAfterAttack = await agentA.get('/api/v1/cart');
    expect(cartAAfterAttack.body.data.items).toHaveLength(1);
    expect(cartAAfterAttack.body.data.items[0].id).toBe(itemAId);

    // 7. Logout revokes active session in PostgreSQL cleanly
    const logoutRes = await agentA.post('/api/v1/auth/logout').set('x-csrf-token', csrfA);
    expect(logoutRes.status).toBe(200);
    const sessionAfterLogout = await agentA.get('/api/v1/auth/session');
    expect(sessionAfterLogout.body.data.authenticated).toBe(false);
    const meAfterLogout = await agentA.get('/api/v1/customers/me');
    expect(meAfterLogout.status).toBe(401);
  }, 60_000);
});
