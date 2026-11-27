import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { requireCustomerAuth } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { OrderStatus } from '@prisma/client';
import { buildCarrierTrackingUrl } from '../services/shippingProvider';

const router = Router();
router.use(requireCustomerAuth);

/**
 * Standard progression order for non-terminal lifecycle statuses
 */
const LIFECYCLE_STEPS: Array<{
  status: OrderStatus;
  label: string;
  defaultDescription: string;
}> = [
  {
    status: 'PENDING',
    label: 'Order Placed',
    defaultDescription: 'We have received your order and are validating details.',
  },
  {
    status: 'CONFIRMED',
    label: 'Order Confirmed',
    defaultDescription: 'Your order has been verified and approved for fulfillment.',
  },
  {
    status: 'PACKED',
    label: 'Packed & Ready',
    defaultDescription: 'Your items have been carefully inspected and securely boxed.',
  },
  {
    status: 'SHIPPED',
    label: 'In Transit',
    defaultDescription: 'Package has been dispatched and handed over to delivery carrier.',
  },
  {
    status: 'OUT_FOR_DELIVERY',
    label: 'Out for Delivery',
    defaultDescription: 'Courier executive is on the way to your delivery address.',
  },
  {
    status: 'DELIVERED',
    label: 'Delivered',
    defaultDescription: 'Package safely delivered to recipient.',
  },
];

/**
 * GET /api/v1/orders
 * Returns all orders for the authenticated customer
 */
router.get('/', async (req: Request, res: Response) => {
  const orders = await prisma.order.findMany({
    where: { customerId: req.customer!.id },
    include: {
      items: true,
      shipment: true,
      payments: true,
      history: { orderBy: { createdAt: 'desc' } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: orders });
});

/**
 * GET /api/v1/orders/:idOrNumber
 * Returns single order details for the authenticated customer
 */
router.get('/:idOrNumber', async (req: Request, res: Response) => {
  const param = String(req.params.idOrNumber);
  const order = await prisma.order.findFirst({
    where: {
      customerId: req.customer!.id,
      OR: [{ id: param }, { orderNumber: param }],
    },
    include: {
      items: true,
      shipment: true,
      payments: true,
      history: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!order) {
    throw new NotFoundError('Order not found');
  }

  res.json({ success: true, data: order });
});

/**
 * GET /api/v1/orders/:idOrNumber/tracking
 * Returns comprehensive tracking timeline, carrier info, and status history for the customer.
 */
router.get('/:idOrNumber/tracking', async (req: Request, res: Response) => {
  const param = String(req.params.idOrNumber);
  const order = await prisma.order.findFirst({
    where: {
      customerId: req.customer!.id,
      OR: [{ id: param }, { orderNumber: param }],
    },
    include: {
      items: true,
      shipment: true,
      payments: true,
      history: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!order) {
    throw new NotFoundError('Order not found');
  }

  const isTerminal = order.status === 'CANCELLED' || order.status === 'REFUNDED';
  const currentIndex = LIFECYCLE_STEPS.findIndex((s) => s.status === order.status);

  // Map history events to status for quick timestamp lookup
  const historyMap = new Map<OrderStatus, { note: string | null; createdAt: Date; updatedBy: string | null }>();
  for (const h of order.history) {
    historyMap.set(h.status, {
      note: h.note,
      createdAt: h.createdAt,
      updatedBy: h.updatedBy,
    });
  }

  // Construct visual timeline steps
  const steps = LIFECYCLE_STEPS.map((step, idx) => {
    const isPastOrCurrent = currentIndex >= 0 && idx <= currentIndex;
    const isCurrent = idx === currentIndex;
    const historyEntry = historyMap.get(step.status);

    let timestamp: string | null = null;
    let description = step.defaultDescription;

    if (historyEntry) {
      timestamp = historyEntry.createdAt.toISOString();
      if (historyEntry.note) {
        description = historyEntry.note;
      }
    } else if (idx === 0) {
      timestamp = order.createdAt.toISOString();
    }

    return {
      status: step.status,
      label: step.label,
      description,
      isCompleted: isPastOrCurrent && !isCurrent,
      isCurrent: isCurrent && !isTerminal,
      isPending: !isPastOrCurrent,
      timestamp,
    };
  });

  // Calculate external carrier tracking URL if not directly set
  const carrierTrackingUrl =
    order.shipment?.carrierTrackingUrl ||
    buildCarrierTrackingUrl(order.shipment?.carrier, order.shipment?.trackingNumber);

  res.json({
    success: true,
    data: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      currentStatus: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      totalAmount: order.totalAmount,
      isTerminal,
      terminalReason: isTerminal
        ? order.history.find((h) => h.status === order.status)?.note ?? `Order ${order.status.toLowerCase()}`
        : null,
      steps,
      shipment: order.shipment
        ? {
            carrier: order.shipment.carrier,
            trackingNumber: order.shipment.trackingNumber,
            awbNumber: order.shipment.awbNumber,
            carrierTrackingUrl,
            status: order.shipment.status,
            estimatedDelivery: order.shipment.estimatedDelivery,
            shippedAt: order.shipment.shippedAt,
            deliveredAt: order.shipment.deliveredAt,
          }
        : null,
      shippingAddress: order.shippingAddressSnapshot,
      items: order.items.map((i) => ({
        id: i.id,
        productName: i.productName,
        packSizeLabel: i.packSizeLabel,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
      })),
      history: order.history.map((h) => ({
        id: h.id,
        status: h.status,
        note: h.note,
        updatedBy: h.updatedBy ?? 'System',
        carrier: h.carrier ?? null,
        trackingNumber: h.trackingNumber ?? null,
        carrierTrackingUrl: h.carrierTrackingUrl ?? null,
        createdAt: h.createdAt,
      })),
    },
  });
});

/**
 * POST /api/v1/orders/:id/cancel
 * Allows a customer to cancel an order before it has been shipped.
 */
router.post('/:id/cancel', async (req: Request, res: Response) => {
  const orderId = String(req.params.id);
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerId: req.customer!.id },
    include: { items: true },
  });

  if (!order) {
    throw new NotFoundError('Order not found');
  }

  if (['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUNDED'].includes(order.status)) {
    throw new BadRequestError(`Order in status ${order.status} cannot be cancelled by customer`);
  }

  const txResults = await prisma.$transaction([
    ...order.items.map((item) =>
      prisma.productVariant.update({
        where: { id: item.variantId },
        data: { stockQuantity: { increment: item.quantity } },
      })
    ),
    prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        history: {
          create: {
            status: 'CANCELLED',
            note: 'Order cancelled by customer via account portal',
            updatedBy: 'Customer',
          },
        },
      },
      include: { items: true, history: true, shipment: true },
    }),
  ]);

  const updated = txResults[txResults.length - 1];
  res.json({ success: true, data: updated });
});

export default router;
