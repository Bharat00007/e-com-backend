import { Router, Request, Response } from 'express';
import multer from 'multer';
import { prisma } from '../config/prisma';
import { requireAdminAuth, requireAdminRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  adminCategorySchema,
  adminCouponSchema,
  adminOrderStatusSchema,
  adminProductSchema,
  adminProductUpdateSchema,
  adminReviewModerateSchema,
  adminVariantStockSchema,
} from '../validators/schemas';
import { storeProductImage } from '../services/storageProvider';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { OrderStatus, PaymentStatus, ReviewStatus, ShipmentStatus } from '@prisma/client';
import { buildCarrierTrackingUrl } from '../services/shippingProvider';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAdminAuth);

async function logAdminAction(
  req: Request,
  action: string,
  entityType: string,
  entityId?: string,
  metadata?: Record<string, unknown>
) {
  await prisma.auditLog.create({
    data: {
      adminId: req.admin!.id,
      action,
      entityType,
      entityId: entityId ?? null,
      metadata: (metadata ?? {}) as object,
      ipAddress: req.ip ?? null,
    },
  });
}

// Products CRUD
router.post(
  '/products',
  requireAdminRole('CATALOG_MANAGER'),
  validate(adminProductSchema),
  async (req: Request, res: Response) => {
    const { variants, ...productData } = req.body;
    const product = await prisma.product.create({
      data: {
        ...productData,
        status: 'ACTIVE',
        variants: { create: variants },
      },
      include: { variants: true, images: true },
    });
    await logAdminAction(req, 'CREATE_PRODUCT', 'Product', product.id, { slug: product.slug });
    res.status(201).json({ success: true, data: product });
  }
);

router.patch(
  '/products/:id',
  requireAdminRole('CATALOG_MANAGER'),
  validate(adminProductUpdateSchema),
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const updated = await prisma.product.update({
      where: { id },
      data: req.body,
      include: { variants: true, images: true },
    });
    await logAdminAction(req, 'UPDATE_PRODUCT', 'Product', updated.id);
    res.json({ success: true, data: updated });
  }
);

router.delete(
  '/products/:id',
  requireAdminRole('CATALOG_MANAGER'),
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const archived = await prisma.product.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
    await logAdminAction(req, 'ARCHIVE_PRODUCT', 'Product', archived.id);
    res.json({ success: true, data: archived });
  }
);

router.post(
  '/products/:id/images',
  requireAdminRole('CATALOG_MANAGER'),
  upload.single('image'),
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundError('Product not found');

    const stored = await storeProductImage(req.file!);
    const image = await prisma.productImage.create({
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
  }
);

router.patch(
  '/variants/:variantId/stock',
  requireAdminRole('CATALOG_MANAGER', 'ORDER_MANAGER'),
  validate(adminVariantStockSchema),
  async (req: Request, res: Response) => {
    const variantId = String(req.params.variantId);
    const { stockQuantity, price, salePrice } = req.body as {
      stockQuantity?: number;
      price?: number;
      salePrice?: number | null;
    };
    const updated = await prisma.productVariant.update({
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
  }
);

// Categories
router.post('/categories', requireAdminRole('CATALOG_MANAGER'), validate(adminCategorySchema), async (req: Request, res: Response) => {
  const category = await prisma.category.create({ data: req.body });
  await logAdminAction(req, 'CREATE_CATEGORY', 'Category', category.id);
  res.status(201).json({ success: true, data: category });
});

// Orders Management
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
};

function mapOrderToShipmentStatus(orderStatus: OrderStatus): ShipmentStatus {
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

router.get('/orders', requireAdminRole('ORDER_MANAGER', 'SUPPORT_AGENT'), async (_req: Request, res: Response) => {
  const orders = await prisma.order.findMany({
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

router.get('/orders/:id', requireAdminRole('ORDER_MANAGER', 'SUPPORT_AGENT'), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const order = await prisma.order.findFirst({
    where: { OR: [{ id }, { orderNumber: id }] },
    include: {
      items: true,
      shipment: true,
      payments: true,
      history: { orderBy: { createdAt: 'asc' } },
      customer: { select: { id: true, fullName: true, email: true, phone: true } },
    },
  });
  if (!order) throw new NotFoundError('Order not found');
  res.json({ success: true, data: order });
});

router.patch(
  '/orders/:id/status',
  requireAdminRole('ORDER_MANAGER'),
  validate(adminOrderStatusSchema),
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const {
      status,
      note,
      carrier,
      trackingNumber,
      carrierTrackingUrl,
      estimatedDelivery,
      paymentStatus,
    } = req.body as {
      status: OrderStatus;
      note?: string;
      carrier?: string;
      trackingNumber?: string;
      carrierTrackingUrl?: string;
      estimatedDelivery?: string;
      paymentStatus?: PaymentStatus;
    };

    const existingOrder = await prisma.order.findUnique({
      where: { id },
      include: { shipment: true, payments: true, items: true },
    });

    if (!existingOrder) {
      throw new NotFoundError('Order not found');
    }

    // Validate status transition
    if (existingOrder.status !== status) {
      const allowed = ALLOWED_TRANSITIONS[existingOrder.status] ?? [];
      if (!allowed.includes(status)) {
        throw new BadRequestError(
          `Invalid status transition from ${existingOrder.status} to ${status}. Allowed next states: ${
            allowed.join(', ') || 'None (terminal state)'
          }`
        );
      }
    }

    // Resolve carrier tracking URL if not explicitly provided
    const resolvedCarrier = carrier || existingOrder.shipment?.carrier || 'Delhivery Express';
    const resolvedTrackingNumber = trackingNumber || existingOrder.shipment?.trackingNumber || null;
    const resolvedTrackingUrl =
      carrierTrackingUrl ||
      existingOrder.shipment?.carrierTrackingUrl ||
      buildCarrierTrackingUrl(resolvedCarrier, resolvedTrackingNumber);

    const now = new Date();
    const adminIdentifier = `Admin (${req.admin!.fullName})`;

    const shipmentStatus = mapOrderToShipmentStatus(status);

    const updated = await prisma.$transaction(async (tx) => {
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
        } else {
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

    await logAdminAction(req, 'UPDATE_ORDER_STATUS', 'Order', updated!.id, {
      previousStatus: existingOrder.status,
      newStatus: status,
      paymentStatus: paymentStatus ?? existingOrder.paymentStatus,
      carrier: resolvedCarrier,
      trackingNumber: resolvedTrackingNumber,
      note,
    });

    res.json({ success: true, data: updated });
  }
);

// Reviews Moderation
router.patch('/reviews/:id/moderate', requireAdminRole('SUPPORT_AGENT'), validate(adminReviewModerateSchema), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { status } = req.body as { status: ReviewStatus };
  const updated = await prisma.review.update({ where: { id }, data: { status } });
  await logAdminAction(req, 'MODERATE_REVIEW', 'Review', updated.id, { status });
  res.json({ success: true, data: updated });
});

// Customers, Coupons & Audit Logs
router.get('/customers', requireAdminRole('SUPPORT_AGENT'), async (_req: Request, res: Response) => {
  const customers = await prisma.customer.findMany({
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

router.post('/coupons', requireAdminRole('CATALOG_MANAGER'), validate(adminCouponSchema), async (req: Request, res: Response) => {
  const coupon = await prisma.coupon.create({ data: req.body });
  await logAdminAction(req, 'CREATE_COUPON', 'Coupon', coupon.id, { code: coupon.code });
  res.status(201).json({ success: true, data: coupon });
});

router.get('/audit-logs', requireAdminRole('SUPER_ADMIN'), async (_req: Request, res: Response) => {
  const logs = await prisma.auditLog.findMany({
    include: { admin: { select: { fullName: true, email: true, role: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ success: true, data: logs });
});

export default router;
