import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { optionalCustomerAuth, requireCustomerAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { checkoutCreateOrderSchema } from '../validators/schemas';
import { AppError, BadRequestError, ConflictError } from '../utils/errors';
import { calculateCartTotals } from '../services/cartCalculator';
import { checkPincodeServiceability } from '../services/shippingProvider';
import { isRazorpayConfigured } from '../services/paymentGateway';
import { validateGuestSession } from '../services/sessionService';
import { GUEST_SESSION_COOKIE } from '../utils/cookies';

const router = Router();

/**
 * @openapi
 * /checkout/quote:
 *   post:
 *     summary: Retrieve authoritative checkout summary & price calculation from backend database
 */
router.post('/quote', optionalCustomerAuth, async (req: Request, res: Response) => {
    const { shippingMethod = 'standard', couponCode, pincode } = req.body as {
        shippingMethod?: 'standard' | 'express';
        couponCode?: string;
        pincode?: string;
    };

    let cart = null;
    if (req.customer) {
        cart = await prisma.cart.findUnique({
            where: { customerId: req.customer.id },
            include: {
                items: {
                    include: {
                        variant: {
                            include: {
                                product: {
                                    include: { images: { where: { isPrimary: true } } },
                                },
                            },
                        },
                    },
                    orderBy: { createdAt: 'asc' },
                },
            },
        });
    } else {
        const gsid = req.cookies?.[GUEST_SESSION_COOKIE] as string | undefined;
        const guestSession = req.guestSession ?? (gsid ? await validateGuestSession(gsid) : null);
        if (guestSession) {
            cart = await prisma.cart.findFirst({
                where: { guestSessionId: guestSession.id, status: 'ACTIVE' },
                include: {
                    items: {
                        include: {
                            variant: {
                                include: {
                                    product: {
                                        include: { images: { where: { isPrimary: true } } },
                                    },
                                },
                            },
                        },
                        orderBy: { createdAt: 'asc' },
                    },
                },
            });
        }
    }

    if (!cart || cart.items.length === 0) {
        return res.json({
            success: true,
            data: {
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
                couponCode: null,
                shippingMethod,
                isValid: false,
                validationErrors: ['Cart is empty'],
            },
        });
    }

    const activeCouponCode = couponCode?.trim().toUpperCase() || cart.couponCode;
    const coupon = activeCouponCode
        ? await prisma.coupon.findUnique({ where: { code: activeCouponCode } })
        : null;

    const validationErrors: string[] = [];
    const quotedItems = cart.items.map((item) => {
        const variant = item.variant;
        const product = variant.product;
        const unitPrice = variant.salePrice ?? variant.price;
        const isOutOfStock = !variant.isAvailable || variant.stockQuantity < item.quantity;

        if (isOutOfStock) {
            validationErrors.push(
                `${product.shortName} (${variant.packSizeLabel}) has only ${variant.stockQuantity} units available.`
            );
        }

        const subscriptionDiscountPercent = item.isSubscription
            ? product.subscriptionDiscountPercent
            : 0;
        const discountApplied = item.isSubscription
            ? Math.round((unitPrice * item.quantity * subscriptionDiscountPercent) / 100)
            : 0;

        return {
            id: item.id,
            variantId: item.variantId,
            productId: product.id,
            name: product.name,
            packSizeLabel: variant.packSizeLabel,
            image: product.images[0]?.url ?? null,
            unitPrice,
            quantity: item.quantity,
            isSubscription: item.isSubscription,
            frequencyWeeks: item.frequencyWeeks,
            lineTotal: unitPrice * item.quantity - discountApplied,
            discountApplied,
            stockAvailable: variant.stockQuantity,
            isOutOfStock,
        };
    });

    if (pincode && pincode.trim().length === 6) {
        try {
            const serviceability = await checkPincodeServiceability(pincode.trim());
            if (!serviceability.serviceable) {
                validationErrors.push(`PIN code ${pincode} is not serviceable.`);
            }
        } catch {
            // Ignore pincode check error on quote
        }
    }

    const totals = calculateCartTotals(
        cart.items.map((i) => ({
            unitPrice: i.variant.salePrice ?? i.variant.price,
            quantity: i.quantity,
            isSubscription: i.isSubscription,
            subscriptionDiscountPercent: i.variant.product.subscriptionDiscountPercent,
        })),
        { coupon, shippingMethod }
    );

    res.json({
        success: true,
        data: {
            items: quotedItems,
            totals,
            couponCode: coupon?.code ?? null,
            shippingMethod,
            isValid: validationErrors.length === 0,
            validationErrors,
        },
    });
});

/**
 * @openapi
 * /checkout/create-order:
 *   post:
 *     summary: Place authenticated order with 100% backend-authoritative calculation
 */
router.post(
    '/create-order',
    requireCustomerAuth,
    validate(checkoutCreateOrderSchema),
    async (req: Request, res: Response) => {
        const {
            idempotencyKey,
            contactEmail,
            contactPhone,
            shippingAddress,
            shippingMethod,
            paymentMethod,
            couponCode,
        } = req.body;

        // Idempotency check to prevent duplicate orders (scoped to owning customer)
        if (idempotencyKey) {
            const existingOrder = await prisma.order.findUnique({
                where: { idempotencyKey },
                include: { items: true, shipment: true },
            });
            if (existingOrder) {
                if (existingOrder.customerId !== req.customer!.id) {
                    throw new ConflictError('Idempotency key already used');
                }
                return res.status(200).json({ success: true, data: existingOrder, idempotent: true });
            }
        }

        if (paymentMethod !== 'COD' && !isRazorpayConfigured()) {
            throw new AppError(
                'Online payment is not configured yet. Please use Cash on Delivery (COD).',
                503,
                'PAYMENT_GATEWAY_NOT_CONFIGURED'
            );
        }

        const serviceability = await checkPincodeServiceability(shippingAddress.pincode);
        if (!serviceability.serviceable) {
            throw new BadRequestError(`PIN code ${shippingAddress.pincode} is not serviceable.`);
        }

        const cart = await prisma.cart.findUnique({
            where: { customerId: req.customer!.id },
            include: {
                items: {
                    include: { variant: { include: { product: true } } },
                },
            },
        });

        if (!cart || cart.items.length === 0) {
            throw new BadRequestError('Your cart is empty');
        }

        const activeCouponCode = couponCode?.trim().toUpperCase() || cart.couponCode;
        const coupon = activeCouponCode
            ? await prisma.coupon.findUnique({ where: { code: activeCouponCode } })
            : null;

        // Authoritative price calculation purely from database records (client prices ignored)
        const totals = calculateCartTotals(
            cart.items.map((i) => ({
                unitPrice: i.variant.salePrice ?? i.variant.price,
                quantity: i.quantity,
                isSubscription: i.isSubscription,
                subscriptionDiscountPercent: i.variant.product.subscriptionDiscountPercent,
            })),
            { coupon, shippingMethod }
        );

        const orderNumber = `SNC-${Math.floor(10000 + Math.random() * 90000)}`;

        // Verify stock availability before atomic batch transaction
        for (const item of cart.items) {
            if (!item.variant.isAvailable || item.variant.stockQuantity < item.quantity) {
                throw new BadRequestError(
                    `Insufficient stock for ${item.variant.product.shortName} (${item.variant.packSizeLabel}). Available: ${item.variant.stockQuantity}`
                );
            }
        }

        const orderId = crypto.randomUUID();

        const txOps = [
            ...cart.items.map((item) =>
                prisma.productVariant.update({
                    where: { id: item.variantId },
                    data: { stockQuantity: { decrement: item.quantity } },
                })
            ),
            ...(coupon && totals.couponDiscount > 0
                ? [
                    prisma.coupon.update({
                        where: { id: coupon.id },
                        data: { usedCount: { increment: 1 } },
                    }),
                ]
                : []),
            prisma.order.create({
                data: {
                    id: orderId,
                    orderNumber,
                    idempotencyKey: idempotencyKey ?? null,
                    customerId: req.customer!.id,
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
                                ? Math.round(
                                    (unitPrice * item.quantity * item.variant.product.subscriptionDiscountPercent) /
                                    100
                                )
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
                            note:
                                paymentMethod === 'COD'
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
            prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
            prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } }),
        ];

        const txResults = await prisma.$transaction(txOps);
        const order = txResults[txResults.length - 3];

        res.status(201).json({ success: true, data: order });
    }
);

export default router;
