import { Coupon, DiscountType } from '@prisma/client';

export interface CalculableCartItem {
  unitPrice: number;
  quantity: number;
  isSubscription: boolean;
  subscriptionDiscountPercent: number;
}

export interface CartTotals {
  subtotal: number;
  subscriptionDiscount: number;
  couponDiscount: number;
  shippingCharge: number;
  taxAmount: number;
  totalAmount: number;
  totalSavings: number;
}

export function calculateCouponDiscount(afterSubTotal: number, coupon?: Coupon | null): number {
  if (!coupon || !coupon.isActive) return 0;
  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) return 0;
  if (coupon.expiresAt && coupon.expiresAt < now) return 0;
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) return 0;
  if (afterSubTotal < coupon.minOrderValue) return 0;

  let discount =
    coupon.discountType === DiscountType.PERCENTAGE
      ? Math.round((afterSubTotal * coupon.discountValue) / 100)
      : coupon.discountValue;

  if (coupon.maxDiscountCap !== null && coupon.maxDiscountCap !== undefined) {
    discount = Math.min(discount, coupon.maxDiscountCap);
  }
  return Math.min(discount, afterSubTotal);
}

export function calculateCartTotals(
  items: CalculableCartItem[],
  options?: {
    coupon?: Coupon | null;
    shippingMethod?: 'standard' | 'express';
  }
): CartTotals {
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  const subscriptionDiscount = items.reduce((sum, item) => {
    if (!item.isSubscription) return sum;
    return sum + Math.round((item.unitPrice * item.quantity * item.subscriptionDiscountPercent) / 100);
  }, 0);

  const afterSubTotal = Math.max(0, subtotal - subscriptionDiscount);
  const couponDiscount = calculateCouponDiscount(afterSubTotal, options?.coupon);
  const afterDiscounts = Math.max(0, afterSubTotal - couponDiscount);

  let shippingCharge = 0;
  if (afterDiscounts > 0) {
    if (options?.shippingMethod === 'express') {
      shippingCharge = 99;
    } else {
      shippingCharge = afterDiscounts >= 499 ? 0 : 49;
    }
  }

  const totalAmount = afterDiscounts + shippingCharge;
  // GST (18% inclusive in Indian MRP)
  const taxAmount = Math.round(totalAmount - totalAmount / 1.18);

  return {
    subtotal,
    subscriptionDiscount,
    couponDiscount,
    shippingCharge,
    taxAmount,
    totalAmount,
    totalSavings: subscriptionDiscount + couponDiscount,
  };
}
