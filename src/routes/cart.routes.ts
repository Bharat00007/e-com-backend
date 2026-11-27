import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { optionalCustomerAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { cartAddSchema, cartUpdateSchema } from '../validators/schemas';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { calculateCartTotals } from '../services/cartCalculator';
import { buildCookieOptions } from '../utils/cookies';

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

  let guestToken = req.cookies?.guestCartToken as string | undefined;
  if (!guestToken) {
    if (!createIfMissing) return null;
    guestToken = crypto.randomUUID();
    res.cookie('guestCartToken', guestToken, buildCookieOptions(30 * 24 * 60 * 60 * 1000));
  }

  let cart = await prisma.cart.findUnique({ where: { guestToken } });
  if (!cart && createIfMissing) {
    cart = await prisma.cart.create({ data: { guestToken } });
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

  return { id: cart.id, couponCode: cart.couponCode, items: cart.items, totals };
}

router.get('/', async (req: Request, res: Response) => {
  if (!req.customer && !req.cookies?.guestCartToken) {
    res.json({ success: true, data: EMPTY_CART_RESPONSE });
    return;
  }
  const cart = await resolveCart(req, res, false);
  if (!cart) {
    res.json({ success: true, data: EMPTY_CART_RESPONSE });
    return;
  }
  const formatted = await formatCartResponse(cart.id);
  res.json({ success: true, data: formatted });
});

router.post('/items', validate(cartAddSchema), async (req: Request, res: Response) => {
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
        isSubscription,
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
      data: { cartId: cart.id, variantId, quantity, isSubscription, frequencyWeeks },
    });
  }

  const formatted = await formatCartResponse(cart.id);
  res.status(201).json({ success: true, data: formatted });
});

router.patch('/items/:itemId', validate(cartUpdateSchema), async (req: Request, res: Response) => {
  const itemId = String(req.params.itemId);
  const cart = await resolveCart(req, res, false);
  if (!cart) throw new NotFoundError('Cart item not found');
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, cartId: cart.id },
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
  await prisma.cartItem.deleteMany({ where: { id: itemId, cartId: cart.id } });
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

export default router;
