"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const prisma_1 = require("../config/prisma");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const schemas_1 = require("../validators/schemas");
const storageProvider_1 = require("../services/storageProvider");
const errors_1 = require("../utils/errors");
const shippingProvider_1 = require("../services/shippingProvider");
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
router.use(auth_1.requireAdminAuth);
async function logAdminAction(req, action, entityType, entityId, metadata) {
    await prisma_1.prisma.auditLog.create({
        data: {
            adminId: req.admin.id,
            action,
            entityType,
            entityId: entityId ?? null,
            metadata: (metadata ?? {}),
            ipAddress: req.ip ?? null,
        },
    });
}
// Products CRUD
router.post('/products', (0, auth_1.requireAdminRole)('CATALOG_MANAGER'), (0, validate_1.validate)(schemas_1.adminProductSchema), async (req, res) => {
    const { variants, ...productData } = req.body;
    const product = await prisma_1.prisma.product.create({
        data: {
            ...productData,
            status: 'ACTIVE',
            variants: { create: variants },
        },
        include: { variants: true, images: true },
    });
    await logAdminAction(req, 'CREATE_PRODUCT', 'Product', product.id, { slug: product.slug });
    res.status(201).json({ success: true, data: product });
});
router.patch('/products/:id', (0, auth_1.requireAdminRole)('CATALOG_MANAGER'), (0, validate_1.validate)(schemas_1.adminProductUpdateSchema), async (req, res) => {
    const id = String(req.params.id);
    const updated = await prisma_1.prisma.product.update({
        where: { id },
        data: req.body,
        include: { variants: true, images: true },
    });
    await logAdminAction(req, 'UPDATE_PRODUCT', 'Product', updated.id);
    res.json({ success: true, data: updated });
});
router.delete('/products/:id', (0, auth_1.requireAdminRole)('CATALOG_MANAGER'), async (req, res) => {
    const id = String(req.params.id);
    const archived = await prisma_1.prisma.product.update({
        where: { id },
        data: { status: 'ARCHIVED' },
    });
    await logAdminAction(req, 'ARCHIVE_PRODUCT', 'Product', archived.id);
    res.json({ success: true, data: archived });
});
router.post('/products/:id/images', (0, auth_1.requireAdminRole)('CATALOG_MANAGER'), upload.single('image'), async (req, res) => {
    const id = String(req.params.id);
    const product = await prisma_1.prisma.product.findUnique({ where: { id } });
    if (!product)
        throw new errors_1.NotFoundError('Product not found');
    const stored = await (0, storageProvider_1.storeProductImage)(req.file);
    const image = await prisma_1.prisma.productImage.create({
        data: {
            productId: product.id,
            url: stored.url,
            altText: product.name,
            isPrimary: false,
        },
    });
    await logAdminAction(req, 'UPLOAD_PRODUCT_IMAGE', 'ProductImage', image.id, {
        url: stored.url,
    });
    res.status(201).json({ success: true, data: image });
});
router.patch('/variants/:variantId/stock', (0, auth_1.requireAdminRole)('CATALOG_MANAGER', 'ORDER_MANAGER'), (0, validate_1.validate)(schemas_1.adminVariantStockSchema), async (req, res) => {
    const variantId = String(req.params.variantId);
    const { stockQuantity, price, salePrice } = req.body;
    const updated = await prisma_1.prisma.productVariant.update({
        where: { id: variantId },
        data: {
            ...(stockQuantity !== undefined ? { stockQuantity, isAvailable: stockQuantity > 0 } : {}),
            ...(price !== undefined ? { price } : {}),
            ...(salePrice !== undefined ? { salePrice } : {}),
        },
    });
    await logAdminAction(req, 'UPDATE_VARIANT', 'ProductVariant', updated.id, {
        stockQuantity,
        price,
    });
    res.json({ success: true, data: updated });
});
// Categories
router.post('/categories', (0, auth_1.requireAdminRole)('CATALOG_MANAGER'), (0, validate_1.validate)(schemas_1.adminCategorySchema), async (req, res) => {
    const category = await prisma_1.prisma.category.create({ data: req.body });
    await logAdminAction(req, 'CREATE_CATEGORY', 'Category', category.id);
    res.status(201).json({ success: true, data: category });
});
// Orders Management
const ALLOWED_TRANSITIONS = {
    PENDING: ['CONFIRMED', 'CANCELLED'],
    CONFIRMED: ['PACKED', 'CANCELLED'],
    PACKED: ['SHIPPED', 'CANCELLED'],
    SHIPPED: ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
    OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
    DELIVERED: ['REFUNDED'],
    CANCELLED: [],
    REFUNDED: [],
};
function mapOrderToShipmentStatus(orderStatus) {
    switch (orderStatus) {
        case 'CONFIRMED':
            return 'PENDING';
        case 'PACKED':
            return 'MANIFESTED';
        case 'SHIPPED':
            return 'IN_TRANSIT';
        case 'OUT_FOR_DELIVERY':
            return 'OUT_FOR_DELIVERY';
        case 'DELIVERED':
            return 'DELIVERED';
        case 'CANCELLED':
            return 'CANCELLED';
        default:
            return 'PENDING';
    }
}
router.get('/orders', (0, auth_1.requireAdminRole)('ORDER_MANAGER', 'SUPPORT_AGENT'), async (_req, res) => {
    const orders = await prisma_1.prisma.order.findMany({
        include: {
            items: true,
            shipment: true,
            payments: true,
            history: { orderBy: { createdAt: 'desc' } },
            customer: { select: { id: true, fullName: true, email: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });
    res.json({ success: true, data: orders });
});
router.get('/orders/:id', (0, auth_1.requireAdminRole)('ORDER_MANAGER', 'SUPPORT_AGENT'), async (req, res) => {
    const id = String(req.params.id);
    const order = await prisma_1.prisma.order.findFirst({
        where: { OR: [{ id }, { orderNumber: id }] },
        include: {
            items: true,
            shipment: true,
            payments: true,
            history: { orderBy: { createdAt: 'asc' } },
            customer: { select: { id: true, fullName: true, email: true, phone: true } },
        },
    });
    if (!order)
        throw new errors_1.NotFoundError('Order not found');
    res.json({ success: true, data: order });
});
router.patch('/orders/:id/status', (0, auth_1.requireAdminRole)('ORDER_MANAGER'), (0, validate_1.validate)(schemas_1.adminOrderStatusSchema), async (req, res) => {
    const id = String(req.params.id);
    const { status, note, carrier, trackingNumber, carrierTrackingUrl, estimatedDelivery, paymentStatus, } = req.body;
    const existingOrder = await prisma_1.prisma.order.findUnique({
        where: { id },
        include: { shipment: true, payments: true, items: true },
    });
    if (!existingOrder) {
        throw new errors_1.NotFoundError('Order not found');
    }
    // Validate status transition
    if (existingOrder.status !== status) {
        const allowed = ALLOWED_TRANSITIONS[existingOrder.status] ?? [];
        if (!allowed.includes(status)) {
            throw new errors_1.BadRequestError(`Invalid status transition from ${existingOrder.status} to ${status}. Allowed next states: ${allowed.join(', ') || 'None (terminal state)'}`);
        }
    }
    // Resolve carrier tracking URL if not explicitly provided
    const resolvedCarrier = carrier || existingOrder.shipment?.carrier || 'Delhivery Express';
    const resolvedTrackingNumber = trackingNumber || existingOrder.shipment?.trackingNumber || null;
    const resolvedTrackingUrl = carrierTrackingUrl ||
        existingOrder.shipment?.carrierTrackingUrl ||
        (0, shippingProvider_1.buildCarrierTrackingUrl)(resolvedCarrier, resolvedTrackingNumber);
    const now = new Date();
    const adminIdentifier = `Admin (${req.admin.fullName})`;
    const shipmentStatus = mapOrderToShipmentStatus(status);
    const updated = await prisma_1.prisma.$transaction(async (tx) => {
        // 1. Restock items if cancelling
        if (status === 'CANCELLED' && existingOrder.status !== 'CANCELLED') {
            for (const item of existingOrder.items) {
                await tx.productVariant.update({
                    where: { id: item.variantId },
                    data: { stockQuantity: { increment: item.quantity } },
                });
            }
        }
        // 2. Update order and create status history
        await tx.order.update({
            where: { id },
            data: {
                status,
                ...(paymentStatus ? { paymentStatus } : {}),
                history: {
                    create: {
                        status,
                        note: note ?? `Order updated to ${status} by admin`,
                        updatedBy: adminIdentifier,
                        carrier: resolvedCarrier,
                        trackingNumber: resolvedTrackingNumber,
                        carrierTrackingUrl: resolvedTrackingUrl,
                    },
                },
            },
        });
        // 3. Upsert shipment details
        await tx.shipment.upsert({
            where: { orderId: id },
            create: {
                orderId: id,
                carrier: resolvedCarrier,
                trackingNumber: resolvedTrackingNumber,
                carrierTrackingUrl: resolvedTrackingUrl,
                status: shipmentStatus,
                estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null,
                shippedAt: status === 'SHIPPED' ? now : null,
                deliveredAt: status === 'DELIVERED' ? now : null,
            },
            update: {
                carrier: resolvedCarrier,
                ...(resolvedTrackingNumber ? { trackingNumber: resolvedTrackingNumber } : {}),
                ...(resolvedTrackingUrl ? { carrierTrackingUrl: resolvedTrackingUrl } : {}),
                status: shipmentStatus,
                ...(estimatedDelivery ? { estimatedDelivery: new Date(estimatedDelivery) } : {}),
                ...(status === 'SHIPPED' && !existingOrder.shipment?.shippedAt ? { shippedAt: now } : {}),
                ...(status === 'DELIVERED' && !existingOrder.shipment?.deliveredAt ? { deliveredAt: now } : {}),
            },
        });
        // 4. If paymentStatus was updated (e.g., COD marked as CAPTURED on delivery)
        if (paymentStatus && paymentStatus === 'CAPTURED') {
            const existingPayment = existingOrder.payments[0];
            if (existingPayment) {
                await tx.payment.update({
                    where: { id: existingPayment.id },
                    data: { status: 'CAPTURED', paidAt: now },
                });
            }
            else {
                await tx.payment.create({
                    data: {
                        orderId: id,
                        amount: existingOrder.totalAmount,
                        currency: 'INR',
                        provider: existingOrder.paymentMethod === 'COD' ? 'cash_on_delivery' : 'manual_admin',
                        status: 'CAPTURED',
                        paidAt: now,
                    },
                });
            }
        }
        return tx.order.findUnique({
            where: { id },
            include: {
                items: true,
                shipment: true,
                payments: true,
                history: { orderBy: { createdAt: 'desc' } },
            },
        });
    }, { maxWait: 15000, timeout: 30000 });
    await logAdminAction(req, 'UPDATE_ORDER_STATUS', 'Order', updated.id, {
        previousStatus: existingOrder.status,
        newStatus: status,
        paymentStatus: paymentStatus ?? existingOrder.paymentStatus,
        carrier: resolvedCarrier,
        trackingNumber: resolvedTrackingNumber,
        note,
    });
    res.json({ success: true, data: updated });
});
// Reviews Moderation
router.patch('/reviews/:id/moderate', (0, auth_1.requireAdminRole)('SUPPORT_AGENT'), (0, validate_1.validate)(schemas_1.adminReviewModerateSchema), async (req, res) => {
    const id = String(req.params.id);
    const { status } = req.body;
    const updated = await prisma_1.prisma.review.update({ where: { id }, data: { status } });
    await logAdminAction(req, 'MODERATE_REVIEW', 'Review', updated.id, { status });
    res.json({ success: true, data: updated });
});
// Customers, Coupons & Audit Logs
router.get('/customers', (0, auth_1.requireAdminRole)('SUPPORT_AGENT'), async (_req, res) => {
    const customers = await prisma_1.prisma.customer.findMany({
        select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            status: true,
            createdAt: true,
            _count: { select: { orders: true, subscriptions: true } },
        },
        orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: customers });
});
router.post('/coupons', (0, auth_1.requireAdminRole)('CATALOG_MANAGER'), (0, validate_1.validate)(schemas_1.adminCouponSchema), async (req, res) => {
    const coupon = await prisma_1.prisma.coupon.create({ data: req.body });
    await logAdminAction(req, 'CREATE_COUPON', 'Coupon', coupon.id, { code: coupon.code });
    res.status(201).json({ success: true, data: coupon });
});
router.get('/audit-logs', (0, auth_1.requireAdminRole)('SUPER_ADMIN'), async (_req, res) => {
    const logs = await prisma_1.prisma.auditLog.findMany({
        include: { admin: { select: { fullName: true, email: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });
    res.json({ success: true, data: logs });
});
exports.default = router;
