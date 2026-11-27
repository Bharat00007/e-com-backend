import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { requireCustomerAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { verifyPaymentSchema } from '../validators/schemas';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  createRazorpayOrder,
  getPaymentConfigurationStatus,
  isRazorpayConfigured,
  verifyRazorpaySignature,
  verifyRazorpayWebhookSignature,
} from '../services/paymentGateway';

const router = Router();

router.get('/configuration-status', (_req: Request, res: Response) => {
  res.json({ success: true, data: getPaymentConfigurationStatus() });
});

router.post('/create-gateway-order', requireCustomerAuth, async (req: Request, res: Response) => {
  const { orderId } = req.body as { orderId?: string };
  if (!orderId) throw new BadRequestError('orderId is required');

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError('Order not found');
  if (order.customerId !== req.customer!.id) {
    throw new ForbiddenError('Not authorized to pay for this order');
  }

  const gatewayOrder = await createRazorpayOrder(order.orderNumber, order.totalAmount);

  await prisma.payment.create({
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

router.post('/verify', requireCustomerAuth, validate(verifyPaymentSchema), async (req: Request, res: Response) => {
  if (!isRazorpayConfigured()) {
    throw new BadRequestError('Online payments are not configured yet.');
  }
  const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

  const existingOrder = await prisma.order.findUnique({ where: { id: orderId } });
  if (!existingOrder) throw new NotFoundError('Order not found');
  if (existingOrder.customerId !== req.customer!.id) {
    throw new ForbiddenError('Not authorized to verify this payment');
  }

  const isValid = verifyRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
  if (!isValid) {
    throw new BadRequestError('Invalid payment signature');
  }

  const txResults = await prisma.$transaction([
    prisma.payment.updateMany({
      where: { orderId, gatewayOrderId: razorpayOrderId },
      data: {
        transactionId: razorpayPaymentId,
        signature: razorpaySignature,
        status: 'CAPTURED',
        paidAt: new Date(),
      },
    }),
    prisma.order.update({
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

router.post('/webhook', async (req: Request, res: Response) => {
  const signature = req.headers['x-razorpay-signature'] as string | undefined;
  if (!signature) throw new BadRequestError('Missing webhook signature');

  const rawBody = JSON.stringify(req.body);
  if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
    throw new BadRequestError('Invalid webhook signature');
  }

  const event = req.body as { event?: string; payload?: { payment?: { entity?: { id: string; order_id: string } } } };
  if (event.event === 'payment.captured' && event.payload?.payment?.entity) {
    const entity = event.payload.payment.entity;
    const payment = await prisma.payment.findUnique({ where: { gatewayOrderId: entity.order_id } });
    if (payment && payment.status !== 'CAPTURED') {
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'CAPTURED', transactionId: entity.id, paidAt: new Date() },
        }),
        prisma.order.update({
          where: { id: payment.orderId },
          data: { status: 'CONFIRMED', paymentStatus: 'CAPTURED' },
        }),
      ]);
    }
  }

  res.json({ success: true, received: true });
});

export default router;
