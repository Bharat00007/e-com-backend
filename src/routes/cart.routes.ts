import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { optionalCustomerAuth, requireCustomerAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { cartAddSchema, cartUpdateSchema } from '../validators/schemas';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { calculateCartTotals } from '../services/cartCalculator';
import {
  clearMergedGuestCookie,
  computeSessionCsrfToken,
  createGuestSession,
  mergeGuestSessionCartAtomically,
  validateGuestSession,
} from '../services/sessionService';
import { GUEST_SESSION_COOKIE } from '../utils/cookies';

const EMPTY_CART_RESPONSE = {
  id: null,
  couponCode: null,
  items: [],
  totals: {
    subtotal: 0,
    subscriptionDiscount: 0,
    couponDiscount: 0,
    shippingCharge: 0,
    taxAmount: 0,
    totalAmount: 0,
    totalSavings: 0,
  },
};

const router = Router();
router.use(optionalCustomerAuth);

// In-memory idempotency cache (15-second TTL per operation key scoped by owner)
interface CachedCartOp {
  timestamp: number;
  data: unknown;
}
const idempotencyCache = new Map<string, CachedCartOp>();

function getCachedOp(ownerKey: string, key?: string) {
  if (!key) return null;
  const scopedKey = `${ownerKey}:${key}`;
  const entry = idempotencyCache.get(scopedKey);
  if (entry && Date.now() - entry.timestamp < 15000) {
    return entry.data;
  }
  if (entry) idempotencyCache.delete(scopedKey);
  return null;
}

function setCachedOp(ownerKey: string, key: string | undefined, data: unknown) {
  if (!key) return;
  idempotencyCache.set(`${ownerKey}:${key}`, { timestamp: Date.now(), data });
  if (idempotencyCache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of idempotencyCache.entries()) {
      if (now - v.timestamp > 15000) idempotencyCache.delete(k);
    }
  }
}

async function resolveCart(req: Request, res: Response, createIfMissing: boolean) {
  // 1. Authenticated customer cart (strictly bound to req.customer.id)
  if (req.customer) {
    let cart = await prisma.cart.findUnique({ where: { customerId: req.customer.id } });
    if (!cart && createIfMissing) {
      cart = await prisma.cart.create({ data: { customerId: req.customer.id, status: 'ACTIVE' } });
    } else if (cart && cart.status !== 'ACTIVE') {
      cart = await prisma.cart.update({ where: { id: cart.id }, data: { status: 'ACTIVE' } });
    }
    return cart;
  }

  // 2. Guest cart (strictly bound to server-issued HttpOnly `gsid` PostgreSQL GuestSession)
  let guestSession =
    req.guestSession ?? (await validateGuestSession(req.cookies?.[GUEST_SESSION_COOKIE] as string | undefined));

  if (!guestSession) {
    if (!createIfMissing) return null;
    const created = await createGuestSession(req, res);
    guestSession = { id: created.session.id, csrfSecret: created.session.csrfSecret };
    req.guestSession = guestSession;
  } else {
    const csrfToken = computeSessionCsrfToken(guestSession.id, guestSession.csrfSecret);
    res.setHeader('x-csrf-token', csrfToken);
  }

  let cart = await prisma.cart.findFirst({
    where: { guestSessionId: guestSession.id, status: 'ACTIVE' },
  });

  if (!cart && createIfMissing) {
    cart = await prisma.cart.create({
      data: {
        guestSessionId: guestSession.id,
        status: 'ACTIVE',
      },
    });
  }

  return cart;
}

async function formatCartResponse(cartId: string) {
  const cart = await prisma.cart.findUniqueOrThrow({
    where: { id: cartId },
    include: {
      items: {
        include: {
          variant: {
            include: {
              product: { include: { images: { where: { isPrimary: true } } } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  const coupon = cart.couponCode
    ? await prisma.coupon.findUnique({ where: { code: cart.couponCode } })
    : null;

  const totals = calculateCartTotals(
    cart.items.map((i) => ({
      unitPrice: i.variant.salePrice ?? i.variant.price,
      quantity: i.quantity,
      isSubscription: i.isSubscription,
      subscriptionDiscountPercent: i.variant.product.subscriptionDiscountPercent,
    })),
    { coupon }
  );

  return {
    id: cart.id,
    couponCode: cart.couponCode,
    items: cart.items,
    totals,
  };
}

router.get('/', async (req: Request, res: Response) => {
  const cart = await resolveCart(req, res, false);
  if (!cart) {
    res.json({ success: true, data: EMPTY_CART_RESPONSE });
    return;
  }
  const formatted = await formatCartResponse(cart.id);
  res.json({ success: true, data: formatted });
});

router.post('/items', validate(cartAddSchema), async (req: Request, res: Response) => {
  const cart = (await resolveCart(req, res, true))!;
  const ownerKey = req.customer ? `c:${req.customer.id}` : `g:${cart.id}`;
  const idempotencyKey =
    (req.headers['x-idempotency-key'] as string | undefined) ||
    (req.body.idempotencyKey as string | undefined);

  const cached = getCachedOp(ownerKey, idempotencyKey);
  if (cached) {
    return res.status(200).json({ success: true, data: cached, idempotent: true });
  }

  const { variantId, quantity, isSubscription, frequencyWeeks } = req.body;
  const variant = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (!variant || !variant.isAvailable) {
    throw new NotFoundError('Product variant not available');
  }
  if (variant.stockQuantity < quantity) {
    throw new BadRequestError(`Only ${variant.stockQuantity} units available in stock`);
  }

  const existing = await prisma.cartItem.findUnique({
    where: {
      cartId_variantId_isSubscription: {
        cartId: cart.id,
        variantId,
        isSubscription: Boolean(isSubscription),
      },
    },
  });

  if (existing) {
    const combinedQty = existing.quantity + quantity;
    if (combinedQty > variant.stockQuantity) {
      throw new BadRequestError(`Only ${variant.stockQuantity} units available in stock`);
    }
    await prisma.cartItem.update({
      where: { id: existing.id },
      data: { quantity: combinedQty, frequencyWeeks },
    });
  } else {
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        variantId,
        quantity,
        isSubscription: Boolean(isSubscription),
        frequencyWeeks,
      },
    });
  }

  const formatted = await formatCartResponse(cart.id);
  setCachedOp(ownerKey, idempotencyKey, formatted);
  res.status(201).json({ success: true, data: formatted });
});

router.patch('/items/:itemId', validate(cartUpdateSchema), async (req: Request, res: Response) => {
  const itemId = String(req.params.itemId);
  const cart = await resolveCart(req, res, false);
  if (!cart) throw new NotFoundError('Cart item not found');

  const item = await prisma.cartItem.findFirst({
    where: {
      cartId: cart.id,
      OR: [{ id: itemId }, { variantId: itemId }],
    },
    include: { variant: true },
  });
  if (!item) throw new NotFoundError('Cart item not found');

  if (req.body.quantity !== undefined && req.body.quantity <= 0) {
    await prisma.cartItem.delete({ where: { id: item.id } });
  } else {
    if (req.body.quantity !== undefined && req.body.quantity > item.variant.stockQuantity) {
      throw new BadRequestError(`Only ${item.variant.stockQuantity} units available in stock`);
    }
    await prisma.cartItem.update({ where: { id: item.id }, data: req.body });
  }

  const formatted = await formatCartResponse(cart.id);
  res.json({ success: true, data: formatted });
});

router.delete('/items/:itemId', async (req: Request, res: Response) => {
  const itemId = String(req.params.itemId);
  const cart = await resolveCart(req, res, false);
  if (!cart) {
    res.json({ success: true, data: EMPTY_CART_RESPONSE });
    return;
  }
  await prisma.cartItem.deleteMany({
    where: {
      cartId: cart.id,
      OR: [{ id: itemId }, { variantId: itemId }],
    },
  });
  const formatted = await formatCartResponse(cart.id);
  res.json({ success: true, data: formatted });
});

router.delete('/', async (req: Request, res: Response) => {
  const cart = await resolveCart(req, res, false);
  if (!cart) {
    res.json({ success: true, data: EMPTY_CART_RESPONSE });
    return;
  }
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
  const formatted = await formatCartResponse(cart.id);
  res.json({ success: true, data: formatted });
});

router.post('/coupon', async (req: Request, res: Response) => {
  const { code } = req.body as { code?: string };
  const cart = (await resolveCart(req, res, true))!;

  if (!code) {
    await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    return res.json({ success: true, data: await formatCartResponse(cart.id) });
  }

  const coupon = await prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
  if (!coupon || !coupon.isActive) {
    throw new BadRequestError('Invalid or expired coupon code');
  }

  await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: coupon.code } });
  res.json({ success: true, data: await formatCartResponse(cart.id) });
});

/**
 * Idempotent Guest-to-Customer Cart Merge endpoint.
 * Merges ONLY the verified GuestSession (`gsid` HttpOnly cookie) into the authenticated customer's cart.
 * Never trusts client-submitted guest IDs or client-submitted item arrays.
 */
router.post('/merge', requireCustomerAuth, async (req: Request, res: Response) => {
  const customerId = req.customer!.id;
  const gsidCookie = req.cookies?.[GUEST_SESSION_COOKIE] as string | undefined;
  const guestSession = gsidCookie ? await validateGuestSession(gsidCookie) : null;

  const mergeResult = await mergeGuestSessionCartAtomically(guestSession?.id, customerId);
  clearMergedGuestCookie(res, req);

  if (!mergeResult.customerCartId) {
    const customerCart = await prisma.cart.findUnique({ where: { customerId } });
    if (!customerCart) {
      res.json({
        success: true,
        data: { ...EMPTY_CART_RESPONSE, mergedCount: 0 },
      });
      return;
    }
    const formatted = await formatCartResponse(customerCart.id);
    res.json({
      success: true,
      data: { ...formatted, mergedCount: mergeResult.mergedCount },
    });
    return;
  }

  const formatted = await formatCartResponse(mergeResult.customerCartId);
  res.json({
    success: true,
    data: {
      ...formatted,
      mergedCount: mergeResult.mergedCount,
    },
  });
});

export default router;
