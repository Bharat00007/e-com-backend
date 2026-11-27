"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../config/prisma");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const schemas_1 = require("../validators/schemas");
const errors_1 = require("../utils/errors");
const router = (0, express_1.Router)();
router.get('/plans', async (_req, res) => {
    const plans = await prisma_1.prisma.subscriptionPlan.findMany({
        where: { isActive: true },
        orderBy: { frequencyWeeks: 'asc' },
    });
    res.json({ success: true, data: plans });
});
router.use(auth_1.requireCustomerAuth);
router.get('/', async (req, res) => {
    const subscriptions = await prisma_1.prisma.subscription.findMany({
        where: { customerId: req.customer.id },
        include: {
            plan: true,
            items: { include: { product: { include: { images: true } }, variant: true } },
            history: { orderBy: { createdAt: 'desc' }, take: 10 },
        },
        orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: subscriptions });
});
router.post('/', (0, validate_1.validate)(schemas_1.subscriptionCreateSchema), async (req, res) => {
    const { planId, variantId, quantity, shippingAddressJson } = req.body;
    const plan = await prisma_1.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan)
        throw new errors_1.NotFoundError('Subscription plan not found');
    const variant = await prisma_1.prisma.productVariant.findUnique({
        where: { id: variantId },
        include: { product: true },
    });
    if (!variant)
        throw new errors_1.NotFoundError('Product variant not found');
    const nextDate = new Date(Date.now() + plan.frequencyWeeks * 7 * 24 * 60 * 60 * 1000);
    const sub = await prisma_1.prisma.subscription.create({
        data: {
            customerId: req.customer.id,
            planId: plan.id,
            status: 'ACTIVE',
            discountPercent: plan.discountPercent,
            nextBillingDate: nextDate,
            nextDeliveryDate: nextDate,
            shippingAddressJson: shippingAddressJson,
            items: {
                create: {
                    productId: variant.productId,
                    variantId: variant.id,
                    quantity,
                    unitPrice: variant.salePrice ?? variant.price,
                },
            },
            history: {
                create: { event: 'CREATED', details: `Started ${plan.name} subscription` },
            },
        },
        include: { plan: true, items: true, history: true },
    });
    res.status(201).json({ success: true, data: sub });
});
router.post('/:id/pause', async (req, res) => {
    const id = String(req.params.id);
    const sub = await prisma_1.prisma.subscription.findFirst({ where: { id, customerId: req.customer.id } });
    if (!sub)
        throw new errors_1.NotFoundError('Subscription not found');
    const updated = await prisma_1.prisma.subscription.update({
        where: { id: sub.id },
        data: {
            status: 'PAUSED',
            history: { create: { event: 'PAUSED', details: 'Paused by customer' } },
        },
    });
    res.json({ success: true, data: updated });
});
router.post('/:id/resume', async (req, res) => {
    const id = String(req.params.id);
    const sub = await prisma_1.prisma.subscription.findFirst({ where: { id, customerId: req.customer.id } });
    if (!sub)
        throw new errors_1.NotFoundError('Subscription not found');
    const updated = await prisma_1.prisma.subscription.update({
        where: { id: sub.id },
        data: {
            status: 'ACTIVE',
            history: { create: { event: 'RESUMED', details: 'Resumed by customer' } },
        },
    });
    res.json({ success: true, data: updated });
});
router.post('/:id/skip', async (req, res) => {
    const id = String(req.params.id);
    const sub = await prisma_1.prisma.subscription.findFirst({
        where: { id, customerId: req.customer.id },
        include: { plan: true },
    });
    if (!sub)
        throw new errors_1.NotFoundError('Subscription not found');
    const shifted = new Date(sub.nextDeliveryDate.getTime() + sub.plan.frequencyWeeks * 7 * 24 * 60 * 60 * 1000);
    const updated = await prisma_1.prisma.subscription.update({
        where: { id: sub.id },
        data: {
            nextDeliveryDate: shifted,
            nextBillingDate: shifted,
            history: { create: { event: 'SKIPPED', details: 'Skipped next delivery cycle' } },
        },
    });
    res.json({ success: true, data: updated });
});
router.post('/:id/cancel', async (req, res) => {
    const id = String(req.params.id);
    const sub = await prisma_1.prisma.subscription.findFirst({ where: { id, customerId: req.customer.id } });
    if (!sub)
        throw new errors_1.NotFoundError('Subscription not found');
    const updated = await prisma_1.prisma.subscription.update({
        where: { id: sub.id },
        data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            history: { create: { event: 'CANCELLED', details: 'Cancelled by customer' } },
        },
    });
    res.json({ success: true, data: updated });
});
exports.default = router;
