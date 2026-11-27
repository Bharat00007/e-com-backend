import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { calculateCouponDiscount } from '../services/cartCalculator';
import { BadRequestError } from '../utils/errors';

const router = Router();

router.post('/validate', async (req: Request, res: Response) => {
  const { code, subtotal = 0 } = req.body as { code?: string; subtotal?: number };
  if (!code) throw new BadRequestError('Coupon code is required');

  const coupon = await prisma.coupon.findUnique({
    where: { code: code.trim().toUpperCase() },
  });
  if (!coupon || !coupon.isActive) {
    throw new BadRequestError('Coupon code is invalid or inactive');
  }

  const discount = calculateCouponDiscount(Number(subtotal), coupon);
  if (discount === 0 && Number(subtotal) < coupon.minOrderValue) {
    throw new BadRequestError(`Minimum order value of ₹${coupon.minOrderValue} required`);
  }

  res.json({
    success: true,
    data: {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      calculatedDiscount: discount,
    },
  });
});

export default router;
