"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../config/prisma");
const shippingProvider_1 = require("../services/shippingProvider");
const errors_1 = require("../utils/errors");
const router = (0, express_1.Router)();
router.get('/pincode/:code', async (req, res) => {
    const code = String(req.params.code);
    const result = await (0, shippingProvider_1.checkPincodeServiceability)(code);
    res.json({ success: true, data: result });
});
router.get('/track/:trackingNumber', async (req, res) => {
    const trackingNumber = String(req.params.trackingNumber);
    const shipment = await prisma_1.prisma.shipment.findUnique({
        where: { trackingNumber },
        include: {
            order: {
                select: { orderNumber: true, status: true, createdAt: true },
            },
        },
    });
    if (!shipment)
        throw new errors_1.NotFoundError('Shipment tracking record not found');
    res.json({ success: true, data: shipment });
});
exports.default = router;
