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
const shippingProvider_1 = require("../services/shippingProvider");
const paymentGateway_1 = require("../services/paymentGateway");
const router = (0, express_1.Router)();
router.use(auth_1.requireCustomerAuth);
router.post('/create-order', (0, validate_1.validate)(schemas_1.checkoutCreateOrderSchema), async (req, res) => {
    const { idempotencyKey, contactEmail, contactPhone, shippingAddress, shippingMethod, paymentMethod, couponCode, } = req.body;
    // Idempotency check to prevent duplicate orders (scoped to owning customer)
    if (idempotencyKey) {
        const existingOrder = await prisma_1.prisma.order.findUnique({
            where: { idempotencyKey },
            include: { items: true, shipment: true },
        });
        if (existingOrder) {
            if (existingOrder.customerId !== req.customer.id) {
                throw new errors_1.ConflictError('Idempotency key already used');
            }
            return res.status(200).json({ success: true, data: existingOrder, idempotent: true });
        }
    }
    if (paymentMethod !== 'COD' && !(0, paymentGateway_1.isRazorpayConfigured)()) {
        throw new errors_1.AppError('Online payment is not configured yet. Please use Cash on Delivery (COD).', 503, 'PAYMENT_GATEWAY_NOT_CONFIGURED');
    }
    const serviceability = await (0, shippingProvider_1.checkPincodeServiceability)(shippingAddress.pincode);
    if (!serviceability.serviceable) {
        throw new errors_1.BadRequestError(`PIN code ${shippingAddress.pincode} is not serviceable.`);
    }
    const cart = await prisma_1.prisma.cart.findUnique({
        where: { customerId: req.customer.id },
        include: {
            items: {
                include: { variant: { include: { product: true } } },
            },
        },
    });
    if (!cart || cart.items.length === 0) {
        throw new errors_1.BadRequestError('Your cart is empty');
    }
    const activeCouponCode = couponCode?.trim().toUpperCase() || cart.couponCode;
    const coupon = activeCouponCode
        ? await prisma_1.prisma.coupon.findUnique({ where: { code: activeCouponCode } })
        : null;
    const totals = (0, cartCalculator_1.calculateCartTotals)(cart.items.map((i) => ({
        unitPrice: i.variant.salePrice ?? i.variant.price,
        quantity: i.quantity,
        isSubscription: i.isSubscription,
        subscriptionDiscountPercent: i.variant.product.subscriptionDiscountPercent,
    })), { coupon, shippingMethod });
    const orderNumber = `SNC-${Math.floor(10000 + Math.random() * 90000)}`;
    // Verify stock availability before atomic batch transaction
    for (const item of cart.items) {
        if (!item.variant.isAvailable || item.variant.stockQuantity < item.quantity) {
            throw new errors_1.BadRequestError(`Insufficient stock for ${item.variant.product.shortName} (${item.variant.packSizeLabel})`);
        }
    }
    const orderId = crypto_1.default.randomUUID();
    const txOps = [
        ...cart.items.map((item) => prisma_1.prisma.productVariant.update({
            where: { id: item.variantId },
            data: { stockQuantity: { decrement: item.quantity } },
        })),
        ...(coupon && totals.couponDiscount > 0
            ? [
                prisma_1.prisma.coupon.update({
                    where: { id: coupon.id },
                    data: { usedCount: { increment: 1 } },
                }),
            ]
            : []),
        prisma_1.prisma.order.create({
            data: {
                id: orderId,
                orderNumber,
                idempotencyKey: idempotencyKey ?? null,
                customerId: req.customer.id,
                customerNameSnapshot: shippingAddress.recipientName,
                customerEmailSnapshot: contactEmail,
                customerPhoneSnapshot: contactPhone,
                shippingAddressSnapshot: shippingAddress,
                status: paymentMethod === 'COD' ? 'CONFIRMED' : 'PENDING',
                paymentStatus: 'PENDING',
                paymentMethod,
                couponCode: coupon?.code ?? null,
                subtotalAmount: totals.subtotal,
                subscriptionDiscount: totals.subscriptionDiscount,
                couponDiscount: totals.couponDiscount,
                shippingCharge: totals.shippingCharge,
                taxAmount: totals.taxAmount,
                totalAmount: totals.totalAmount,
                items: {
                    create: cart.items.map((item) => {
                        const unitPrice = item.variant.salePrice ?? item.variant.price;
                        const discountApplied = item.isSubscription
                            ? Math.round((unitPrice * item.quantity * item.variant.product.subscriptionDiscountPercent) /
                                100)
                            : 0;
                        return {
                            variantId: item.variantId,
                            productName: item.variant.product.name,
                            packSizeLabel: item.variant.packSizeLabel,
                            sku: item.variant.sku,
                            unitPrice,
                            discountApplied,
                            quantity: item.quantity,
                            lineTotal: unitPrice * item.quantity - discountApplied,
                            isSubscription: item.isSubscription,
                            frequencyWeeks: item.frequencyWeeks,
                        };
                    }),
                },
                history: {
                    create: {
                        status: paymentMethod === 'COD' ? 'CONFIRMED' : 'PENDING',
                        note: paymentMethod === 'COD'
                            ? 'Confirmed via Cash on Delivery'
                            : 'Awaiting payment verification',
                    },
                },
                shipment: {
                    create: {
                        shippingMethod,
                        carrier: 'Delhivery Express',
                        trackingNumber: `SNC-DLHV-${Math.floor(1000 + Math.random() * 9000)}`,
                        status: 'PENDING',
                    },
                },
            },
            include: { items: true, shipment: true, history: true },
        }),
        prisma_1.prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
        prisma_1.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } }),
    ];
    const txResults = await prisma_1.prisma.$transaction(txOps);
    const order = txResults[txResults.length - 3];
    res.status(201).json({ success: true, data: order });
});
exports.default = router;
