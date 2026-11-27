import { describe, it, expect } from 'vitest';
import { calculateCartTotals, calculateCouponDiscount } from '../src/services/cartCalculator';
import { DiscountType, Coupon } from '@prisma/client';

describe('cartCalculator', () => {
  it('calculates 15% subscription discount and free shipping above ₹499', () => {
    const totals = calculateCartTotals([
      { unitPrice: 699, quantity: 1, isSubscription: true, subscriptionDiscountPercent: 15 },
      { unitPrice: 399, quantity: 1, isSubscription: false, subscriptionDiscountPercent: 15 },
    ]);

    expect(totals.subtotal).toBe(1098);
    expect(totals.subscriptionDiscount).toBe(105);
    expect(totals.shippingCharge).toBe(0);
    expect(totals.totalAmount).toBe(993);
  });

  it('charges ₹49 standard shipping when order total is below ₹499', () => {
    const totals = calculateCartTotals([
      { unitPrice: 299, quantity: 1, isSubscription: false, subscriptionDiscountPercent: 15 },
    ]);

    expect(totals.shippingCharge).toBe(49);
    expect(totals.totalAmount).toBe(348);
  });

  it('charges ₹99 for express shipping regardless of subtotal', () => {
    const totals = calculateCartTotals(
      [{ unitPrice: 699, quantity: 1, isSubscription: false, subscriptionDiscountPercent: 15 }],
      { shippingMethod: 'express' }
    );

    expect(totals.shippingCharge).toBe(99);
    expect(totals.totalAmount).toBe(798);
  });

  it('validates percentage coupon with minOrderValue', () => {
    const coupon: Coupon = {
      id: 'c1',
      code: 'SNIFF10',
      description: '10% off',
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      minOrderValue: 499,
      maxDiscountCap: null,
      usageLimit: null,
      usedCount: 0,
      customerOnly: false,
      startsAt: null,
      expiresAt: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(calculateCouponDiscount(400, coupon)).toBe(0);
    expect(calculateCouponDiscount(1000, coupon)).toBe(100);
  });
});
