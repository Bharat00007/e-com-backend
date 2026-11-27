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
async function resolveCart(req, res, createIfMissing) {
    if (req.customer) {
        let cart = await prisma_1.prisma.cart.findUnique({ where: { customerId: req.customer.id } });
        if (!cart && createIfMissing) {
            cart = await prisma_1.prisma.cart.create({ data: { customerId: req.customer.id } });
        }
        return cart;
    }
    let guestToken = req.cookies?.guestCartToken;
    if (!guestToken) {
        if (!createIfMissing)
            return null;
        guestToken = crypto_1.default.randomUUID();
        res.cookie('guestCartToken', guestToken, (0, cookies_1.buildCookieOptions)(30 * 24 * 60 * 60 * 1000));
    }
    let cart = await prisma_1.prisma.cart.findUnique({ where: { guestToken } });
    if (!cart && createIfMissing) {
        cart = await prisma_1.prisma.cart.create({ data: { guestToken } });
    }
    return cart;
}
async function formatCartResponse(cartId) {
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
    const coupon = cart.couponCode
        ? await prisma_1.prisma.coupon.findUnique({ where: { code: cart.couponCode } })
        : null;
    const totals = (0, cartCalculator_1.calculateCartTotals)(cart.items.map((i) => ({
        unitPrice: i.variant.salePrice ?? i.variant.price,
        quantity: i.quantity,
        isSubscription: i.isSubscription,
        subscriptionDiscountPercent: i.variant.product.subscriptionDiscountPercent,
    })), { coupon });
    return { id: cart.id, couponCode: cart.couponCode, items: cart.items, totals };
}
router.get('/', async (req, res) => {
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
router.post('/items', (0, validate_1.validate)(schemas_1.cartAddSchema), async (req, res) => {
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
                isSubscription,
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
            data: { cartId: cart.id, variantId, quantity, isSubscription, frequencyWeeks },
        });
    }
    const formatted = await formatCartResponse(cart.id);
    res.status(201).json({ success: true, data: formatted });
});
router.patch('/items/:itemId', (0, validate_1.validate)(schemas_1.cartUpdateSchema), async (req, res) => {
    const itemId = String(req.params.itemId);
    const cart = await resolveCart(req, res, false);
    if (!cart)
        throw new errors_1.NotFoundError('Cart item not found');
    const item = await prisma_1.prisma.cartItem.findFirst({
        where: { id: itemId, cartId: cart.id },
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
    const formatted = await formatCartResponse(cart.id);
    res.json({ success: true, data: formatted });
});
router.delete('/items/:itemId', async (req, res) => {
    const itemId = String(req.params.itemId);
    const cart = await resolveCart(req, res, false);
    if (!cart) {
        res.json({ success: true, data: EMPTY_CART_RESPONSE });
        return;
    }
    await prisma_1.prisma.cartItem.deleteMany({ where: { id: itemId, cartId: cart.id } });
    const formatted = await formatCartResponse(cart.id);
    res.json({ success: true, data: formatted });
});
router.post('/coupon', async (req, res) => {
    const { code } = req.body;
    const cart = (await resolveCart(req, res, true));
    if (!code) {
        await prisma_1.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
        return res.json({ success: true, data: await formatCartResponse(cart.id) });
    }
    const coupon = await prisma_1.prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
    if (!coupon || !coupon.isActive) {
        throw new errors_1.BadRequestError('Invalid or expired coupon code');
    }
    await prisma_1.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: coupon.code } });
    res.json({ success: true, data: await formatCartResponse(cart.id) });
});
exports.default = router;
