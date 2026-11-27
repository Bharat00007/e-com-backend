import { z } from 'zod';

const INDIAN_MOBILE_REGEX = /^(?:\+?91|0)?([6-9]\d{9})$/;

export function normalizeIndianMobile(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s\-()]/g, '');
  const match = INDIAN_MOBILE_REGEX.exec(cleaned);
  return match ? match[1] : null;
}

export function isValidEmail(raw: string): boolean {
  return z.string().email().safeParse(raw.trim()).success;
}

export const registerSchema = z.object({
  body: z
    .object({
      fullName: z
        .string()
        .trim()
        .min(2, 'Full name must be at least 2 characters')
        .max(100, 'Full name must be under 100 characters'),
      email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
      phone: z.string().trim().optional(),
      password: z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .max(128, 'Password must be under 128 characters'),
      marketingConsent: z.boolean().optional().default(false),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (data.phone && !normalizeIndianMobile(data.phone)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phone'],
          message: 'Please enter a valid 10-digit Indian mobile number',
        });
      }
    }),
});

export const verifyOtpSchema = z.object({
  body: z
    .object({
      email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
      otp: z
        .string()
        .trim()
        .regex(/^[0-9]{6}$/, 'Verification code must be 6 numeric digits'),
    })
    .strict(),
});

export const resendOtpSchema = z.object({
  body: z
    .object({
      email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
    })
    .strict(),
});

export const loginSchema = z.object({
  body: z
    .object({
      identifier: z.string().trim().min(3, 'Email address is required').optional(),
      email: z.string().trim().toLowerCase().email('Please enter a valid email address').optional(),
      password: z.string().min(1, 'Password is required'),
      rememberMe: z.boolean().optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (!data.email && !data.identifier) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['email'],
          message: 'Email address is required',
        });
      }
    }),
});

export const addressSchema = z.object({
  body: z.object({
    label: z.string().trim().min(1).max(30).default('Home'),
    recipientName: z.string().trim().min(2).max(100),
    phone: z.string().trim().min(8).max(15),
    alternatePhone: z.string().trim().max(15).optional(),
    addressLine1: z.string().trim().min(4).max(200),
    addressLine2: z.string().trim().min(2).max(200),
    landmark: z.string().trim().max(120).optional(),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().min(2).max(80),
    pincode: z.string().regex(/^[0-9]{6}$/, 'PIN code must be 6 digits'),
    isDefault: z.boolean().optional(),
  }),
});

export const cartAddSchema = z.object({
  body: z.object({
    variantId: z.string().min(1),
    quantity: z.number().int().min(1).max(20).default(1),
    isSubscription: z.boolean().default(false),
    frequencyWeeks: z.number().int().min(1).max(12).optional(),
  }),
});

export const cartUpdateSchema = z.object({
  body: z.object({
    quantity: z.number().int().min(0).max(20).optional(),
    isSubscription: z.boolean().optional(),
    frequencyWeeks: z.number().int().min(1).max(12).optional(),
  }),
});

export const checkoutCreateOrderSchema = z.object({
  body: z.object({
    idempotencyKey: z.string().min(8).max(100).optional(),
    contactEmail: z.string().email(),
    contactPhone: z.string().min(8).max(15),
    shippingAddress: z.object({
      recipientName: z.string().min(2),
      phone: z.string().min(8),
      addressLine1: z.string().min(4),
      addressLine2: z.string().min(2),
      city: z.string().min(2),
      state: z.string().min(2),
      pincode: z.string().regex(/^[0-9]{6}$/),
    }),
    shippingMethod: z.enum(['standard', 'express']).default('standard'),
    paymentMethod: z.enum(['UPI', 'CARD', 'NETBANKING', 'COD']).default('UPI'),
    couponCode: z.string().trim().optional(),
  }),
});

export const verifyPaymentSchema = z.object({
  body: z.object({
    orderId: z.string().min(1),
    razorpayOrderId: z.string().min(1),
    razorpayPaymentId: z.string().min(1),
    razorpaySignature: z.string().min(1),
  }),
});

export const reviewCreateSchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().max(120).optional(),
    comment: z.string().trim().min(5).max(1000),
  }),
});

export const subscriptionCreateSchema = z.object({
  body: z.object({
    planId: z.string().min(1),
    variantId: z.string().min(1),
    quantity: z.number().int().min(1).max(10).default(1),
    shippingAddressJson: z.record(z.unknown()),
  }),
});

export const adminProductSchema = z.object({
  body: z.object({
    slug: z.string().trim().min(2),
    name: z.string().trim().min(2),
    shortName: z.string().trim().min(2),
    kicker: z.string().trim().min(2),
    subtitle: z.string().trim().min(2),
    description: z.string().trim().min(10),
    categoryId: z.string().min(1),
    petCategory: z.enum(['CATS', 'DOGS', 'BOTH']).default('BOTH'),
    badge: z.string().optional(),
    secondaryBadge: z.string().optional(),
    features: z.array(z.string()).default([]),
    isFeatured: z.boolean().default(false),
    isBestseller: z.boolean().default(false),
    variants: z
      .array(
        z.object({
          sku: z.string().min(2),
          packSizeLabel: z.string().min(1),
          weightGrams: z.number().int().positive().optional(),
          price: z.number().int().positive(),
          salePrice: z.number().int().positive().nullable().optional(),
          stockQuantity: z.number().int().min(0).default(0),
          isDefault: z.boolean().default(false),
        })
      )
      .min(1),
  }),
});

export const customerProfileUpdateSchema = z.object({
  body: z
    .object({
      fullName: z.string().trim().min(2).max(100).optional(),
      phone: z.string().trim().optional(),
      marketingConsent: z.boolean().optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (data.phone && !normalizeIndianMobile(data.phone)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phone'],
          message: 'Please enter a valid 10-digit Indian mobile number',
        });
      }
    }),
});

export const adminProductUpdateSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(160).optional(),
      shortName: z.string().trim().min(2).max(100).optional(),
      kicker: z.string().trim().min(2).max(100).optional(),
      subtitle: z.string().trim().min(2).max(200).optional(),
      description: z.string().trim().min(10).max(2000).optional(),
      badge: z.string().trim().max(40).nullable().optional(),
      secondaryBadge: z.string().trim().max(40).nullable().optional(),
      features: z.array(z.string().trim()).optional(),
      isFeatured: z.boolean().optional(),
      isBestseller: z.boolean().optional(),
      status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
    })
    .strict(),
});

export const adminVariantStockSchema = z.object({
  body: z
    .object({
      stockQuantity: z.number().int().min(0).max(100000).optional(),
      price: z.number().int().positive().max(100000).optional(),
      salePrice: z.number().int().positive().max(100000).nullable().optional(),
    })
    .strict(),
});

export const adminCategorySchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(80),
      slug: z.string().trim().min(2).max(80),
      description: z.string().trim().max(300).optional(),
      sortOrder: z.number().int().min(0).optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

export const adminOrderStatusSchema = z.object({
  body: z
    .object({
      status: z.enum([
        'PENDING',
        'CONFIRMED',
        'PACKED',
        'SHIPPED',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'CANCELLED',
        'REFUNDED',
      ]),
      note: z.string().trim().max(500).optional(),
      carrier: z.string().trim().max(100).optional(),
      trackingNumber: z.string().trim().max(100).optional(),
      carrierTrackingUrl: z.string().trim().max(500).optional(),
      estimatedDelivery: z.string().optional(),
      paymentStatus: z
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

export const adminReviewModerateSchema = z.object({
  body: z
    .object({
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
    })
    .strict(),
});

export const adminCouponSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(3).max(32),
      description: z.string().trim().max(200).optional(),
      discountType: z.enum(['PERCENTAGE', 'FIXED']),
      discountValue: z.number().int().positive().max(10000),
      minOrderValue: z.number().int().min(0).default(0),
      maxDiscountCap: z.number().int().positive().optional(),
      usageLimit: z.number().int().positive().optional(),
      isActive: z.boolean().default(true),
    })
    .strict(),
});
