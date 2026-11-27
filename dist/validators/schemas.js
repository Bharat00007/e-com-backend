"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminCouponSchema = exports.adminReviewModerateSchema = exports.adminOrderStatusSchema = exports.adminCategorySchema = exports.adminVariantStockSchema = exports.adminProductUpdateSchema = exports.customerProfileUpdateSchema = exports.adminProductSchema = exports.subscriptionCreateSchema = exports.reviewCreateSchema = exports.verifyPaymentSchema = exports.checkoutCreateOrderSchema = exports.cartUpdateSchema = exports.cartAddSchema = exports.addressSchema = exports.loginSchema = exports.resendOtpSchema = exports.verifyOtpSchema = exports.registerSchema = void 0;
exports.normalizeIndianMobile = normalizeIndianMobile;
exports.isValidEmail = isValidEmail;
const zod_1 = require("zod");
const INDIAN_MOBILE_REGEX = /^(?:\+?91|0)?([6-9]\d{9})$/;
function normalizeIndianMobile(raw) {
    const cleaned = raw.trim().replace(/[\s\-()]/g, '');
    const match = INDIAN_MOBILE_REGEX.exec(cleaned);
    return match ? match[1] : null;
}
function isValidEmail(raw) {
    return zod_1.z.string().email().safeParse(raw.trim()).success;
}
exports.registerSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        fullName: zod_1.z
            .string()
            .trim()
            .min(2, 'Full name must be at least 2 characters')
            .max(100, 'Full name must be under 100 characters'),
        email: zod_1.z.string().trim().toLowerCase().email('Please enter a valid email address'),
        phone: zod_1.z.string().trim().optional(),
        password: zod_1.z
            .string()
            .min(8, 'Password must be at least 8 characters')
            .max(128, 'Password must be under 128 characters'),
        marketingConsent: zod_1.z.boolean().optional().default(false),
    })
        .strict()
        .superRefine((data, ctx) => {
        if (data.phone && !normalizeIndianMobile(data.phone)) {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
                path: ['phone'],
                message: 'Please enter a valid 10-digit Indian mobile number',
            });
        }
    }),
});
exports.verifyOtpSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        email: zod_1.z.string().trim().toLowerCase().email('Please enter a valid email address'),
        otp: zod_1.z
            .string()
            .trim()
            .regex(/^[0-9]{6}$/, 'Verification code must be 6 numeric digits'),
    })
        .strict(),
});
exports.resendOtpSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        email: zod_1.z.string().trim().toLowerCase().email('Please enter a valid email address'),
    })
        .strict(),
});
exports.loginSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        identifier: zod_1.z.string().trim().min(3, 'Email address is required').optional(),
        email: zod_1.z.string().trim().toLowerCase().email('Please enter a valid email address').optional(),
        password: zod_1.z.string().min(1, 'Password is required'),
    })
        .strict()
        .superRefine((data, ctx) => {
        if (!data.email && !data.identifier) {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
                path: ['email'],
                message: 'Email address is required',
            });
        }
    }),
});
exports.addressSchema = zod_1.z.object({
    body: zod_1.z.object({
        label: zod_1.z.string().trim().min(1).max(30).default('Home'),
        recipientName: zod_1.z.string().trim().min(2).max(100),
        phone: zod_1.z.string().trim().min(8).max(15),
        alternatePhone: zod_1.z.string().trim().max(15).optional(),
        addressLine1: zod_1.z.string().trim().min(4).max(200),
        addressLine2: zod_1.z.string().trim().min(2).max(200),
        landmark: zod_1.z.string().trim().max(120).optional(),
        city: zod_1.z.string().trim().min(2).max(80),
        state: zod_1.z.string().trim().min(2).max(80),
        pincode: zod_1.z.string().regex(/^[0-9]{6}$/, 'PIN code must be 6 digits'),
        isDefault: zod_1.z.boolean().optional(),
    }),
});
exports.cartAddSchema = zod_1.z.object({
    body: zod_1.z.object({
        variantId: zod_1.z.string().min(1),
        quantity: zod_1.z.number().int().min(1).max(20).default(1),
        isSubscription: zod_1.z.boolean().default(false),
        frequencyWeeks: zod_1.z.number().int().min(1).max(12).optional(),
    }),
});
exports.cartUpdateSchema = zod_1.z.object({
    body: zod_1.z.object({
        quantity: zod_1.z.number().int().min(0).max(20).optional(),
        isSubscription: zod_1.z.boolean().optional(),
        frequencyWeeks: zod_1.z.number().int().min(1).max(12).optional(),
    }),
});
exports.checkoutCreateOrderSchema = zod_1.z.object({
    body: zod_1.z.object({
        idempotencyKey: zod_1.z.string().min(8).max(100).optional(),
        contactEmail: zod_1.z.string().email(),
        contactPhone: zod_1.z.string().min(8).max(15),
        shippingAddress: zod_1.z.object({
            recipientName: zod_1.z.string().min(2),
            phone: zod_1.z.string().min(8),
            addressLine1: zod_1.z.string().min(4),
            addressLine2: zod_1.z.string().min(2),
            city: zod_1.z.string().min(2),
            state: zod_1.z.string().min(2),
            pincode: zod_1.z.string().regex(/^[0-9]{6}$/),
        }),
        shippingMethod: zod_1.z.enum(['standard', 'express']).default('standard'),
        paymentMethod: zod_1.z.enum(['UPI', 'CARD', 'NETBANKING', 'COD']).default('UPI'),
        couponCode: zod_1.z.string().trim().optional(),
    }),
});
exports.verifyPaymentSchema = zod_1.z.object({
    body: zod_1.z.object({
        orderId: zod_1.z.string().min(1),
        razorpayOrderId: zod_1.z.string().min(1),
        razorpayPaymentId: zod_1.z.string().min(1),
        razorpaySignature: zod_1.z.string().min(1),
    }),
});
exports.reviewCreateSchema = zod_1.z.object({
    body: zod_1.z.object({
        productId: zod_1.z.string().min(1),
        rating: zod_1.z.number().int().min(1).max(5),
        title: zod_1.z.string().trim().max(120).optional(),
        comment: zod_1.z.string().trim().min(5).max(1000),
    }),
});
exports.subscriptionCreateSchema = zod_1.z.object({
    body: zod_1.z.object({
        planId: zod_1.z.string().min(1),
        variantId: zod_1.z.string().min(1),
        quantity: zod_1.z.number().int().min(1).max(10).default(1),
        shippingAddressJson: zod_1.z.record(zod_1.z.unknown()),
    }),
});
exports.adminProductSchema = zod_1.z.object({
    body: zod_1.z.object({
        slug: zod_1.z.string().trim().min(2),
        name: zod_1.z.string().trim().min(2),
        shortName: zod_1.z.string().trim().min(2),
        kicker: zod_1.z.string().trim().min(2),
        subtitle: zod_1.z.string().trim().min(2),
        description: zod_1.z.string().trim().min(10),
        categoryId: zod_1.z.string().min(1),
        petCategory: zod_1.z.enum(['CATS', 'DOGS', 'BOTH']).default('BOTH'),
        badge: zod_1.z.string().optional(),
        secondaryBadge: zod_1.z.string().optional(),
        features: zod_1.z.array(zod_1.z.string()).default([]),
        isFeatured: zod_1.z.boolean().default(false),
        isBestseller: zod_1.z.boolean().default(false),
        variants: zod_1.z
            .array(zod_1.z.object({
            sku: zod_1.z.string().min(2),
            packSizeLabel: zod_1.z.string().min(1),
            weightGrams: zod_1.z.number().int().positive().optional(),
            price: zod_1.z.number().int().positive(),
            salePrice: zod_1.z.number().int().positive().nullable().optional(),
            stockQuantity: zod_1.z.number().int().min(0).default(0),
            isDefault: zod_1.z.boolean().default(false),
        }))
            .min(1),
    }),
});
exports.customerProfileUpdateSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        fullName: zod_1.z.string().trim().min(2).max(100).optional(),
        phone: zod_1.z.string().trim().optional(),
        marketingConsent: zod_1.z.boolean().optional(),
    })
        .strict()
        .superRefine((data, ctx) => {
        if (data.phone && !normalizeIndianMobile(data.phone)) {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
                path: ['phone'],
                message: 'Please enter a valid 10-digit Indian mobile number',
            });
        }
    }),
});
exports.adminProductUpdateSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        name: zod_1.z.string().trim().min(2).max(160).optional(),
        shortName: zod_1.z.string().trim().min(2).max(100).optional(),
        kicker: zod_1.z.string().trim().min(2).max(100).optional(),
        subtitle: zod_1.z.string().trim().min(2).max(200).optional(),
        description: zod_1.z.string().trim().min(10).max(2000).optional(),
        badge: zod_1.z.string().trim().max(40).nullable().optional(),
        secondaryBadge: zod_1.z.string().trim().max(40).nullable().optional(),
        features: zod_1.z.array(zod_1.z.string().trim()).optional(),
        isFeatured: zod_1.z.boolean().optional(),
        isBestseller: zod_1.z.boolean().optional(),
        status: zod_1.z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
    })
        .strict(),
});
exports.adminVariantStockSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        stockQuantity: zod_1.z.number().int().min(0).max(100000).optional(),
        price: zod_1.z.number().int().positive().max(100000).optional(),
        salePrice: zod_1.z.number().int().positive().max(100000).nullable().optional(),
    })
        .strict(),
});
exports.adminCategorySchema = zod_1.z.object({
    body: zod_1.z
        .object({
        name: zod_1.z.string().trim().min(2).max(80),
        slug: zod_1.z.string().trim().min(2).max(80),
        description: zod_1.z.string().trim().max(300).optional(),
        sortOrder: zod_1.z.number().int().min(0).optional(),
        isActive: zod_1.z.boolean().optional(),
    })
        .strict(),
});
exports.adminOrderStatusSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        status: zod_1.z.enum([
            'PENDING',
            'CONFIRMED',
            'PACKED',
            'SHIPPED',
            'OUT_FOR_DELIVERY',
            'DELIVERED',
            'CANCELLED',
            'REFUNDED',
        ]),
        note: zod_1.z.string().trim().max(500).optional(),
        carrier: zod_1.z.string().trim().max(100).optional(),
        trackingNumber: zod_1.z.string().trim().max(100).optional(),
        carrierTrackingUrl: zod_1.z.string().trim().max(500).optional(),
        estimatedDelivery: zod_1.z.string().optional(),
        paymentStatus: zod_1.z
            .enum([
            'PENDING',
            'AUTHORIZED',
            'CAPTURED',
            'FAILED',
            'REFUNDED',
            'PARTIALLY_REFUNDED',
        ])
            .optional(),
    })
        .strict(),
});
exports.adminReviewModerateSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        status: zod_1.z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    })
        .strict(),
});
exports.adminCouponSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        code: zod_1.z.string().trim().min(3).max(32),
        description: zod_1.z.string().trim().max(200).optional(),
        discountType: zod_1.z.enum(['PERCENTAGE', 'FIXED']),
        discountValue: zod_1.z.number().int().positive().max(10000),
        minOrderValue: zod_1.z.number().int().min(0).default(0),
        maxDiscountCap: zod_1.z.number().int().positive().optional(),
        usageLimit: zod_1.z.number().int().positive().optional(),
        isActive: zod_1.z.boolean().default(true),
    })
        .strict(),
});
