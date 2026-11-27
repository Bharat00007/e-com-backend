"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../config/prisma");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const schemas_1 = require("../validators/schemas");
const errors_1 = require("../utils/errors");
const router = (0, express_1.Router)();
router.use(auth_1.requireCustomerAuth);
router.get('/me', async (req, res) => {
    const customer = await prisma_1.prisma.customer.findUnique({
        where: { id: req.customer.id },
        select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            emailVerified: true,
            createdAt: true,
            addresses: { orderBy: { isDefault: 'desc' } },
            _count: { select: { orders: true, subscriptions: true } },
        },
    });
    res.json({ success: true, data: customer });
});
router.patch('/me', (0, validate_1.validate)(schemas_1.customerProfileUpdateSchema), async (req, res) => {
    const { fullName, phone, marketingConsent } = req.body;
    const normalizedPhone = phone ? (0, schemas_1.normalizeIndianMobile)(phone) : undefined;
    if (normalizedPhone) {
        const existing = await prisma_1.prisma.customer.findUnique({ where: { phone: normalizedPhone } });
        if (existing && existing.id !== req.customer.id) {
            throw new errors_1.ConflictError('An account with this mobile number already exists');
        }
    }
    const updated = await prisma_1.prisma.customer.update({
        where: { id: req.customer.id },
        data: {
            ...(fullName ? { fullName: fullName.trim() } : {}),
            ...(normalizedPhone ? { phone: normalizedPhone } : {}),
            ...(marketingConsent !== undefined ? { marketingConsent } : {}),
        },
        select: { id: true, fullName: true, email: true, phone: true, marketingConsent: true },
    });
    res.json({ success: true, data: updated });
});
router.get('/addresses', async (req, res) => {
    const addresses = await prisma_1.prisma.address.findMany({
        where: { customerId: req.customer.id },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, data: addresses });
});
router.post('/addresses', (0, validate_1.validate)(schemas_1.addressSchema), async (req, res) => {
    const data = req.body;
    if (data.isDefault) {
        await prisma_1.prisma.address.updateMany({
            where: { customerId: req.customer.id },
            data: { isDefault: false },
        });
    }
    const address = await prisma_1.prisma.address.create({
        data: { ...data, customerId: req.customer.id },
    });
    res.status(201).json({ success: true, data: address });
});
router.patch('/addresses/:id', (0, validate_1.validate)(schemas_1.addressSchema), async (req, res) => {
    const addressId = String(req.params.id);
    const existing = await prisma_1.prisma.address.findFirst({
        where: { id: addressId, customerId: req.customer.id },
    });
    if (!existing)
        throw new errors_1.NotFoundError('Address not found');
    if (req.body.isDefault) {
        await prisma_1.prisma.address.updateMany({
            where: { customerId: req.customer.id },
            data: { isDefault: false },
        });
    }
    const updated = await prisma_1.prisma.address.update({
        where: { id: existing.id },
        data: req.body,
    });
    res.json({ success: true, data: updated });
});
router.delete('/addresses/:id', async (req, res) => {
    const addressId = String(req.params.id);
    const existing = await prisma_1.prisma.address.findFirst({
        where: { id: addressId, customerId: req.customer.id },
    });
    if (!existing)
        throw new errors_1.NotFoundError('Address not found');
    await prisma_1.prisma.address.delete({ where: { id: existing.id } });
    res.json({ success: true, message: 'Address deleted' });
});
exports.default = router;
