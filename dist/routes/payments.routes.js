"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../config/prisma");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const schemas_1 = require("../validators/schemas");
const errors_1 = require("../utils/errors");
const paymentGateway_1 = require("../services/paymentGateway");
const router = (0, express_1.Router)();
router.get('/configuration-status', (_req, res) => {
    res.json({ success: true, data: (0, paymentGateway_1.getPaymentConfigurationStatus)() });
});
router.post('/create-gateway-order', auth_1.requireCustomerAuth, async (req, res) => {
    const { orderId } = req.body;
    if (!orderId)
        throw new errors_1.BadRequestError('orderId is required');
    const order = await prisma_1.prisma.order.findUnique({ where: { id: orderId } });
    if (!order)
        throw new errors_1.NotFoundError('Order not found');
    if (order.customerId !== req.customer.id) {
        throw new errors_1.ForbiddenError('Not authorized to pay for this order');
    }
    const gatewayOrder = await (0, paymentGateway_1.createRazorpayOrder)(order.orderNumber, order.totalAmount);
    await prisma_1.prisma.payment.create({
        data: {
            orderId: order.id,
            provider: 'razorpay',
            gatewayOrderId: gatewayOrder.gatewayOrderId,
            amount: order.totalAmount,
            status: 'PENDING',
        },
    });
    res.json({ success: true, data: gatewayOrder });
});
router.post('/verify', auth_1.requireCustomerAuth, (0, validate_1.validate)(schemas_1.verifyPaymentSchema), async (req, res) => {
    if (!(0, paymentGateway_1.isRazorpayConfigured)()) {
        throw new errors_1.BadRequestError('Online payments are not configured yet.');
    }
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    const existingOrder = await prisma_1.prisma.order.findUnique({ where: { id: orderId } });
    if (!existingOrder)
        throw new errors_1.NotFoundError('Order not found');
    if (existingOrder.customerId !== req.customer.id) {
        throw new errors_1.ForbiddenError('Not authorized to verify this payment');
    }
    const isValid = (0, paymentGateway_1.verifyRazorpaySignature)(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!isValid) {
        throw new errors_1.BadRequestError('Invalid payment signature');
    }
    const txResults = await prisma_1.prisma.$transaction([
        prisma_1.prisma.payment.updateMany({
            where: { orderId, gatewayOrderId: razorpayOrderId },
            data: {
                transactionId: razorpayPaymentId,
                signature: razorpaySignature,
                status: 'CAPTURED',
                paidAt: new Date(),
            },
        }),
        prisma_1.prisma.order.update({
            where: { id: orderId },
            data: {
                status: 'CONFIRMED',
                paymentStatus: 'CAPTURED',
                history: {
                    create: { status: 'CONFIRMED', note: `Payment verified (${razorpayPaymentId})` },
                },
            },
        }),
    ]);
    const order = txResults[1];
    res.json({ success: true, data: order });
});
router.post('/webhook', async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature)
        throw new errors_1.BadRequestError('Missing webhook signature');
    const rawBody = JSON.stringify(req.body);
    if (!(0, paymentGateway_1.verifyRazorpayWebhookSignature)(rawBody, signature)) {
        throw new errors_1.BadRequestError('Invalid webhook signature');
    }
    const event = req.body;
    if (event.event === 'payment.captured' && event.payload?.payment?.entity) {
        const entity = event.payload.payment.entity;
        const payment = await prisma_1.prisma.payment.findUnique({ where: { gatewayOrderId: entity.order_id } });
        if (payment && payment.status !== 'CAPTURED') {
            await prisma_1.prisma.$transaction([
                prisma_1.prisma.payment.update({
                    where: { id: payment.id },
                    data: { status: 'CAPTURED', transactionId: entity.id, paidAt: new Date() },
                }),
                prisma_1.prisma.order.update({
                    where: { id: payment.orderId },
                    data: { status: 'CONFIRMED', paymentStatus: 'CAPTURED' },
                }),
            ]);
        }
    }
    res.json({ success: true, received: true });
});
exports.default = router;
