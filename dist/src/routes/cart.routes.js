"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = require("../config/prisma");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const schemas_1 = require("../validators/schemas");
const errors_1 = require("../utils/errors");
const cartCalculator_1 = require("../services/cartCalculator");
const cookies_1 = require("../utils/cookies");
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
const router = (0, express_1.Router)();
router.use(auth_1.optionalCustomerAuth);
const idempotencyCache = new Map();
function getCachedOp(key) {
    if (!key)
        return null;
    const entry = idempotencyCache.get(key);
    if (entry && Date.now() - entry.timestamp < 15000) {
        return entry.data;
    }
    if (entry)
        idempotencyCache.delete(key);
    return null;
}
function setCachedOp(key, data) {
    if (!key)
        return;
    idempotencyCache.set(key, { timestamp: Date.now(), data });
    // Opportunistic purge
    if (idempotencyCache.size > 2000) {
        const now = Date.now();
        for (const [k, v] of idempotencyCache.entries()) {
            if (now - v.timestamp > 15000)
                idempotencyCache.delete(k);
        }
    }
}
async function resolveCart(req, res, createIfMissing) {
    if (req.customer) {
        let cart = await prisma_1.prisma.cart.findUnique({ where: { customerId: req.customer.id } });
        if (!cart && createIfMissing) {
            cart = await prisma_1.prisma.cart.create({ data: { customerId: req.customer.id } });
        }
        return cart;
    }
    let guestToken = req.headers['x-guest-cart-token']?.trim() ||
        req.cookies?.guestCartToken?.trim() ||
        req.body?.guestToken?.trim();
    if (!guestToken) {
        if (!createIfMissing)
            return null;
        guestToken = crypto_1.default.randomUUID();
        res.cookie('guestCartToken', guestToken, (0, cookies_1.buildCookieOptions)(30 * 24 * 60 * 60 * 1000));
    }
    res.setHeader('x-guest-cart-token', guestToken);
    let cart = await prisma_1.prisma.cart.findUnique({ where: { guestToken } });
    if (!cart && createIfMissing) {
        cart = await prisma_1.prisma.cart.create({ data: { guestToken } });
    }
    return cart;
}
async function formatCartResponse(cartId, res) {
    const cart = await prisma_1.prisma.cart.findUniqueOrThrow({
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
        ? await prisma_1.prisma.coupon.findUnique({ where: { code: cart.couponCode } })
        : null;
    const totals = (0, cartCalculator_1.calculateCartTotals)(cart.items.map((i) => ({
        unitPrice: i.variant.salePrice ?? i.variant.price,
        quantity: i.quantity,
        isSubscription: i.isSubscription,
        subscriptionDiscountPercent: i.variant.product.subscriptionDiscountPercent,
    })), { coupon });
    return {
        id: cart.id,
        guestToken: cart.guestToken,
        couponCode: cart.couponCode,
        items: cart.items,
        totals,
    };
}
router.get('/', async (req, res) => {
    const guestHeader = req.headers['x-guest-cart-token']?.trim();
    const guestCookie = req.cookies?.guestCartToken;
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
router.post('/items', (0, validate_1.validate)(schemas_1.cartAddSchema), async (req, res) => {
    const idempotencyKey = req.headers['x-idempotency-key'] ||
        req.body.idempotencyKey;
    const cached = getCachedOp(idempotencyKey);
    if (cached) {
        return res.status(200).json({ success: true, data: cached, idempotent: true });
    }
    const { variantId, quantity, isSubscription, frequencyWeeks } = req.body;
    const variant = await prisma_1.prisma.productVariant.findUnique({ where: { id: variantId } });
    if (!variant || !variant.isAvailable) {
        throw new errors_1.NotFoundError('Product variant not available');
    }
    if (variant.stockQuantity < quantity) {
        throw new errors_1.BadRequestError(`Only ${variant.stockQuantity} units available in stock`);
    }
    const cart = (await resolveCart(req, res, true));
    const existing = await prisma_1.prisma.cartItem.findUnique({
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
            throw new errors_1.BadRequestError(`Only ${variant.stockQuantity} units available in stock`);
        }
        await prisma_1.prisma.cartItem.update({
            where: { id: existing.id },
            data: { quantity: combinedQty, frequencyWeeks },
        });
    }
    else {
        await prisma_1.prisma.cartItem.create({
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
router.patch('/items/:itemId', (0, validate_1.validate)(schemas_1.cartUpdateSchema), async (req, res) => {
    const itemId = String(req.params.itemId);
    const cart = await resolveCart(req, res, false);
    if (!cart)
        throw new errors_1.NotFoundError('Cart item not found');
    const item = await prisma_1.prisma.cartItem.findFirst({
        where: {
            cartId: cart.id,
            OR: [{ id: itemId }, { variantId: itemId }],
        },
        include: { variant: true },
    });
    if (!item)
        throw new errors_1.NotFoundError('Cart item not found');
    if (req.body.quantity !== undefined && req.body.quantity <= 0) {
        await prisma_1.prisma.cartItem.delete({ where: { id: item.id } });
    }
    else {
        if (req.body.quantity !== undefined && req.body.quantity > item.variant.stockQuantity) {
            throw new errors_1.BadRequestError(`Only ${item.variant.stockQuantity} units available in stock`);
        }
        await prisma_1.prisma.cartItem.update({ where: { id: item.id }, data: req.body });
    }
    const formatted = await formatCartResponse(cart.id, res);
    res.json({ success: true, data: formatted });
});
router.delete('/items/:itemId', async (req, res) => {
    const itemId = String(req.params.itemId);
    const cart = await resolveCart(req, res, false);
    if (!cart) {
        res.json({ success: true, data: EMPTY_CART_RESPONSE });
        return;
    }
    await prisma_1.prisma.cartItem.deleteMany({
        where: {
            cartId: cart.id,
            OR: [{ id: itemId }, { variantId: itemId }],
        },
    });
    const formatted = await formatCartResponse(cart.id, res);
    res.json({ success: true, data: formatted });
});
// Dedicated Clear Cart endpoint
router.delete('/', async (req, res) => {
    const cart = await resolveCart(req, res, false);
    if (!cart) {
        res.json({ success: true, data: EMPTY_CART_RESPONSE });
        return;
    }
    await prisma_1.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma_1.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    const formatted = await formatCartResponse(cart.id, res);
    res.json({ success: true, data: formatted });
});
router.post('/coupon', async (req, res) => {
    const { code } = req.body;
    const cart = (await resolveCart(req, res, true));
    if (!code) {
        await prisma_1.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
        return res.json({ success: true, data: await formatCartResponse(cart.id, res) });
    }
    const coupon = await prisma_1.prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
    if (!coupon || !coupon.isActive) {
        throw new errors_1.BadRequestError('Invalid or expired coupon code');
    }
    await prisma_1.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: coupon.code } });
    res.json({ success: true, data: await formatCartResponse(cart.id, res) });
});
// Explicit Guest-to-Customer Cart Merge endpoint
router.post('/merge', auth_1.requireCustomerAuth, async (req, res) => {
    const customerId = req.customer.id;
    const guestToken = req.body?.guestToken?.trim() ||
        req.headers['x-guest-cart-token']?.trim() ||
        req.cookies?.guestCartToken?.trim();
    let customerCart = await prisma_1.prisma.cart.findUnique({
        where: { customerId },
        include: { items: true },
    });
    if (!customerCart) {
        customerCart = await prisma_1.prisma.cart.create({
            data: { customerId },
            include: { items: true },
        });
    }
    let mergedCount = 0;
    const existingMap = new Map(customerCart.items.map((ci) => [`${ci.variantId}:${ci.isSubscription}`, ci]));
    // 1. Merge by guestToken in database
    if (guestToken) {
        const guestCart = await prisma_1.prisma.cart.findUnique({
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
                    await prisma_1.prisma.cartItem.update({
                        where: { id: existing.id },
                        data: { quantity: combinedQty },
                    });
                    mergedCount += 1;
                }
                else {
                    const cappedQty = Math.min(item.quantity, maxStock);
                    const created = await prisma_1.prisma.cartItem.create({
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
            await prisma_1.prisma.cart.delete({ where: { id: guestCart.id } });
        }
    }
    // 2. Fallback: Merge explicit items array sent from frontend localStorage
    const explicitItems = req.body?.items;
    if (Array.isArray(explicitItems) && explicitItems.length > 0) {
        for (const item of explicitItems) {
            const isSub = Boolean(item.isSubscription);
            const key = `${item.variantId}:${isSub}`;
            const existing = existingMap.get(key);
            const variant = await prisma_1.prisma.productVariant.findUnique({ where: { id: item.variantId } });
            if (!variant || !variant.isAvailable)
                continue;
            const maxStock = variant.stockQuantity;
            if (existing) {
                const combinedQty = Math.min(existing.quantity + item.quantity, maxStock);
                await prisma_1.prisma.cartItem.update({
                    where: { id: existing.id },
                    data: { quantity: combinedQty },
                });
                mergedCount += 1;
            }
            else {
                const cappedQty = Math.min(item.quantity, maxStock);
                const created = await prisma_1.prisma.cartItem.create({
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
exports.default = router;
