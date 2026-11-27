"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../config/prisma");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const schemas_1 = require("../validators/schemas");
const router = (0, express_1.Router)();
router.get('/product/:productId', async (req, res) => {
    const productId = String(req.params.productId);
    const reviews = await prisma_1.prisma.review.findMany({
        where: { productId, status: 'APPROVED' },
        include: { customer: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: reviews });
});
router.post('/', auth_1.requireCustomerAuth, (0, validate_1.validate)(schemas_1.reviewCreateSchema), async (req, res) => {
    const { productId, rating, title, comment } = req.body;
    const review = await prisma_1.prisma.review.upsert({
        where: { productId_customerId: { productId, customerId: req.customer.id } },
        update: { rating, title, comment, status: 'APPROVED' },
        create: {
            productId,
            customerId: req.customer.id,
            rating,
            title,
            comment,
            status: 'APPROVED',
        },
    });
    res.status(201).json({ success: true, data: review });
});
exports.default = router;
