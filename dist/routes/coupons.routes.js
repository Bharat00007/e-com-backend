"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../config/prisma");
const cartCalculator_1 = require("../services/cartCalculator");
const errors_1 = require("../utils/errors");
const router = (0, express_1.Router)();
router.post('/validate', async (req, res) => {
    const { code, subtotal = 0 } = req.body;
    if (!code)
        throw new errors_1.BadRequestError('Coupon code is required');
    const coupon = await prisma_1.prisma.coupon.findUnique({
        where: { code: code.trim().toUpperCase() },
    });
    if (!coupon || !coupon.isActive) {
        throw new errors_1.BadRequestError('Coupon code is invalid or inactive');
    }
    const discount = (0, cartCalculator_1.calculateCouponDiscount)(Number(subtotal), coupon);
    if (discount === 0 && Number(subtotal) < coupon.minOrderValue) {
        throw new errors_1.BadRequestError(`Minimum order value of ₹${coupon.minOrderValue} required`);
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
exports.default = router;
