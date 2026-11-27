import { PrismaClient } from '@prisma/client';

const BASE = 'http://localhost:4000/api/v1';
const prisma = new PrismaClient();

async function req(path: string, init: RequestInit = {}, cookies?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const data = await res.json().catch(() => null);
  return { status: res.status, data, setCookie };
}

async function run() {
  const email = `qa.api.${Date.now()}@example.in`;
  const results: Array<{ name: string; pass: boolean; detail: string }> = [];
  const record = (name: string, pass: boolean, detail: string) => {
    results.push({ name, pass, detail });
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
  };

  // 1. Products & Categories
  const prods = await req('/products');
  record('GET /products', prods.status === 200 && prods.data.data.length === 6, `status=${prods.status}, count=${prods.data?.data?.length}`);

  const invalidProd = await req('/products/non-existent-slug-999');
  record('GET /products/:invalidSlug returns 404', invalidProd.status === 404, `status=${invalidProd.status}`);

  // 2. Auth: Register, Duplicate, Wrong Password, Login, Protected Routes, Logout
  const reg = await req('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ fullName: 'API QA User', email, password: 'StrongPassword@1' }),
  });
  const cookieHeader = reg.setCookie.map((c) => c.split(';')[0]).join('; ');
  record('POST /auth/register', reg.status === 201, `status=${reg.status}`);

  const dup = await req('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ fullName: 'API QA User', email, password: 'StrongPassword@1' }),
  });
  record('POST /auth/register duplicate returns 409', dup.status === 409, `status=${dup.status}`);

  const badLogin = await req('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: email, password: 'WrongPassword!' }),
  });
  record('POST /auth/login wrong password returns 401', badLogin.status === 401, `status=${badLogin.status}`);

  const me = await req('/customers/me', {}, cookieHeader);
  record('GET /customers/me authenticated', me.status === 200 && me.data.data.email === email, `status=${me.status}`);

  // 3. Cart, Coupon, Checkout (COD), Order Cancel & Stock Consistency
  const variantId = prods.data.data[0].variants[0].id;
  const stockBefore = prods.data.data[0].variants[0].stockQuantity;

  const cartAdd = await req('/cart/items', {
    method: 'POST',
    body: JSON.stringify({ variantId, quantity: 2, isSubscription: true, frequencyWeeks: 4 }),
  }, cookieHeader);
  record('POST /cart/items', cartAdd.status === 201 && cartAdd.data.data.totals.subscriptionDiscount > 0, `total=${cartAdd.data?.data?.totals?.totalAmount}`);

  const badCoupon = await req('/cart/coupon', {
    method: 'POST',
    body: JSON.stringify({ code: 'FAKECOUPON99' }),
  }, cookieHeader);
  record('POST /cart/coupon invalid returns 400', badCoupon.status === 400, `status=${badCoupon.status}`);

  const goodCoupon = await req('/cart/coupon', {
    method: 'POST',
    body: JSON.stringify({ code: 'SNIFF10' }),
  }, cookieHeader);
  record('POST /cart/coupon SNIFF10', goodCoupon.status === 200 && goodCoupon.data.data.totals.couponDiscount > 0, `discount=${goodCoupon.data?.data?.totals?.couponDiscount}`);

  const idempotencyKey = `qa-idem-${Date.now()}`;
  const orderRes = await req('/checkout/create-order', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey,
      contactEmail: email,
      contactPhone: '+919820012345',
      shippingAddress: {
        recipientName: 'API QA User',
        phone: '+919820012345',
        addressLine1: 'Flat 101',
        addressLine2: 'MG Road',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411001',
      },
      shippingMethod: 'standard',
      paymentMethod: 'COD',
    }),
  }, cookieHeader);
  record('POST /checkout/create-order (COD)', orderRes.status === 201, `orderNumber=${orderRes.data?.data?.orderNumber}`);

  const idemRes = await req('/checkout/create-order', {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey,
      contactEmail: email,
      contactPhone: '+919820012345',
      shippingAddress: {
        recipientName: 'API QA User',
        phone: '+919820012345',
        addressLine1: 'Flat 101',
        addressLine2: 'MG Road',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411001',
      },
      shippingMethod: 'standard',
      paymentMethod: 'COD',
    }),
  }, cookieHeader);
  record('POST /checkout/create-order idempotency', idemRes.status === 200 && idemRes.data.idempotent === true, `idempotent=${idemRes.data?.idempotent}`);

  const orderId = orderRes.data.data.id;
  const cancelRes = await req(`/orders/${orderId}/cancel`, { method: 'POST' }, cookieHeader);
  record('POST /orders/:id/cancel restores stock', cancelRes.status === 200 && cancelRes.data.data.status === 'CANCELLED', `status=${cancelRes.data?.data?.status}`);

  const variantAfter = await prisma.productVariant.findUnique({ where: { id: variantId } });
  record('Inventory consistency after order + cancel', variantAfter?.stockQuantity === stockBefore, `before=${stockBefore}, after=${variantAfter?.stockQuantity}`);

  // 4. Subscriptions
  const plans = await req('/subscriptions/plans');
  const planId = plans.data.data[0].id;
  const subCreate = await req('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ planId, variantId, quantity: 1, shippingAddressJson: { city: 'Pune' } }),
  }, cookieHeader);
  const subId = subCreate.data?.data?.id;
  record('POST /subscriptions', subCreate.status === 201, `subId=${subId}`);

  const subPause = await req(`/subscriptions/${subId}/pause`, { method: 'POST' }, cookieHeader);
  record('POST /subscriptions/:id/pause', subPause.status === 200 && subPause.data.data.status === 'PAUSED', `status=${subPause.data?.data?.status}`);

  const subResume = await req(`/subscriptions/${subId}/resume`, { method: 'POST' }, cookieHeader);
  record('POST /subscriptions/:id/resume', subResume.status === 200 && subResume.data.data.status === 'ACTIVE', `status=${subResume.data?.data?.status}`);

  const subCancel = await req(`/subscriptions/${subId}/cancel`, { method: 'POST' }, cookieHeader);
  record('POST /subscriptions/:id/cancel', subCancel.status === 200 && subCancel.data.data.status === 'CANCELLED', `status=${subCancel.data?.data?.status}`);

  // 5. Cleanup QA customer & orders so Supabase stays clean
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.customer.deleteMany({ where: { email } });

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nLive API QA Summary: ${results.length - failed}/${results.length} passed, ${failed} failed.`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

run().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
