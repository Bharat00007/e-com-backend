import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { optionalCustomerAuth, requireCustomerAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { cartAddSchema, cartUpdateSchema } from '../validators/schemas';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { calculateCartTotals } from '../services/cartCalculator';
import { buildCookieOptions } from '../utils/cookies';

const EMPTY_CART_RESPONSE = {
  id: null,
  guestToken: null,
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

// In-memory idempotency cache (15-second TTL per operation key)
interface CachedCartOp {
  timestamp: number;
  data: unknown;
}
const idempotencyCache = new Map<string, CachedCartOp>();

function getCachedOp(key?: string) {
  if (!key) return null;
  const entry = idempotencyCache.get(key);
  if (entry && Date.now() - entry.timestamp < 15000) {
    return entry.data;
  }
  if (entry) idempotencyCache.delete(key);
  return null;
}

function setCachedOp(key: string | undefined, data: unknown) {
  if (!key) return;
  idempotencyCache.set(key, { timestamp: Date.now(), data });
  // Opportunistic purge
  if (idempotencyCache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of idempotencyCache.entries()) {
      if (now - v.timestamp > 15000) idempotencyCache.delete(k);
    }
  }
}

async function resolveCart(
  req: Request,
  res: Response,
  createIfMissing: boolean
) {
  if (req.customer) {
    let cart = await prisma.cart.findUnique({ where: { customerId: req.customer.id } });
    if (!cart && createIfMissing) {
      cart = await prisma.cart.create({ data: { customerId: req.customer.id } });
    }
    return cart;
  }

  let guestToken =
    (req.headers['x-guest-cart-token'] as string | undefined)?.trim() ||
    (req.cookies?.guestCartToken as string | undefined)?.trim() ||
    (req.body?.guestToken as string | undefined)?.trim();

  if (!guestToken) {
    if (!createIfMissing) return null;
    guestToken = crypto.randomUUID();
    res.cookie('guestCartToken', guestToken, buildCookieOptions(30 * 24 * 60 * 60 * 1000));
  }

  res.setHeader('x-guest-cart-token', guestToken);

  let cart = await prisma.cart.findUnique({ where: { guestToken } });
  if (!cart && createIfMissing) {
    cart = await prisma.cart.create({ data: { guestToken } });
  }
  return cart;
}

async function formatCartResponse(cartId: string, res?: Response) {
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

  if (cart.guestToken && res) {
    res.setHeader('x-guest-cart-token', cart.guestToken);
  }

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
    guestToken: cart.guestToken,
    couponCode: cart.couponCode,
    items: cart.items,
    totals,
  };
}

router.get('/', async (req: Request, res: Response) => {
  const guestHeader = (req.headers['x-guest-cart-token'] as string | undefined)?.trim();
  const guestCookie = req.cookies?.guestCartToken as string | undefined;

  if (!req.customer && !guestHeader && !guestCookie) {
    res.json({ success: true, data: EMPTY_CART_RESPONSE });
    return;
  }
  const cart = await resolveCart(req, res, false);
  if (!cart) {
    res.json({ success: true, data: EMPTY_CART_RESPONSE });
    return;
  }
  const formatted = await formatCartResponse(cart.id, res);
  res.json({ success: true, data: formatted });
});

router.post('/items', validate(cartAddSchema), async (req: Request, res: Response) => {
  const idempotencyKey =
    (req.headers['x-idempotency-key'] as string | undefined) ||
    (req.body.idempotencyKey as string | undefined);

  const cached = getCachedOp(idempotencyKey);
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

  const cart = (await resolveCart(req, res, true))!;
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

  const formatted = await formatCartResponse(cart.id, res);
  setCachedOp(idempotencyKey, formatted);
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

  const formatted = await formatCartResponse(cart.id, res);
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
  const formatted = await formatCartResponse(cart.id, res);
  res.json({ success: true, data: formatted });
});

// Dedicated Clear Cart endpoint
router.delete('/', async (req: Request, res: Response) => {
  const cart = await resolveCart(req, res, false);
  if (!cart) {
    res.json({ success: true, data: EMPTY_CART_RESPONSE });
    return;
  }
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
  const formatted = await formatCartResponse(cart.id, res);
  res.json({ success: true, data: formatted });
});

router.post('/coupon', async (req: Request, res: Response) => {
  const { code } = req.body as { code?: string };
  const cart = (await resolveCart(req, res, true))!;

  if (!code) {
    await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    return res.json({ success: true, data: await formatCartResponse(cart.id, res) });
  }

  const coupon = await prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
  if (!coupon || !coupon.isActive) {
    throw new BadRequestError('Invalid or expired coupon code');
  }

  await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: coupon.code } });
  res.json({ success: true, data: await formatCartResponse(cart.id, res) });
});

// Explicit Guest-to-Customer Cart Merge endpoint
router.post('/merge', requireCustomerAuth, async (req: Request, res: Response) => {
  const customerId = req.customer!.id;
  const guestToken =
    (req.body?.guestToken as string | undefined)?.trim() ||
    (req.headers['x-guest-cart-token'] as string | undefined)?.trim() ||
    (req.cookies?.guestCartToken as string | undefined)?.trim();

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

  let mergedCount = 0;
  const existingMap = new Map(
    customerCart.items.map((ci) => [`${ci.variantId}:${ci.isSubscription}`, ci])
  );

  // 1. Merge by guestToken in database
  if (guestToken) {
    const guestCart = await prisma.cart.findUnique({
      where: { guestToken },
      include: { items: { include: { variant: true } } },
    });

    if (guestCart && guestCart.items.length > 0) {
      for (const item of guestCart.items) {
        const key = `${item.variantId}:${item.isSubscription}`;
        const existing = existingMap.get(key);
        const maxStock = item.variant.stockQuantity;

        if (existing) {
          const combinedQty = Math.min(existing.quantity + item.quantity, maxStock);
          await prisma.cartItem.update({
            where: { id: existing.id },
            data: { quantity: combinedQty },
          });
          mergedCount += 1;
        } else {
          const cappedQty = Math.min(item.quantity, maxStock);
          const created = await prisma.cartItem.create({
            data: {
              cartId: customerCart.id,
              variantId: item.variantId,
              quantity: cappedQty,
              isSubscription: item.isSubscription,
              frequencyWeeks: item.frequencyWeeks,
            },
          });
          existingMap.set(key, created);
          mergedCount += 1;
        }
      }
      await prisma.cart.delete({ where: { id: guestCart.id } });
    }
  }

  // 2. Fallback: Merge explicit items array sent from frontend localStorage
  const explicitItems = req.body?.items as
    | Array<{ variantId: string; quantity: number; isSubscription?: boolean; frequencyWeeks?: number }>
    | undefined;

  if (Array.isArray(explicitItems) && explicitItems.length > 0) {
    for (const item of explicitItems) {
      const isSub = Boolean(item.isSubscription);
      const key = `${item.variantId}:${isSub}`;
      const existing = existingMap.get(key);

      const variant = await prisma.productVariant.findUnique({ where: { id: item.variantId } });
      if (!variant || !variant.isAvailable) continue;
      const maxStock = variant.stockQuantity;

      if (existing) {
        const combinedQty = Math.min(existing.quantity + item.quantity, maxStock);
        await prisma.cartItem.update({
          where: { id: existing.id },
          data: { quantity: combinedQty },
        });
        mergedCount += 1;
      } else {
        const cappedQty = Math.min(item.quantity, maxStock);
        const created = await prisma.cartItem.create({
          data: {
            cartId: customerCart.id,
            variantId: item.variantId,
            quantity: cappedQty,
            isSubscription: isSub,
            frequencyWeeks: item.frequencyWeeks || 4,
          },
        });
        existingMap.set(key, created);
        mergedCount += 1;
      }
    }
  }

  res.clearCookie('guestCartToken');
  const formatted = await formatCartResponse(customerCart.id, res);
  res.json({
    success: true,
    data: {
      ...formatted,
      mergedCount,
    },
  });
});

export default router;
