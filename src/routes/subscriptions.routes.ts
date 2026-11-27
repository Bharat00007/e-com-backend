import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { requireCustomerAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { subscriptionCreateSchema } from '../validators/schemas';
import { NotFoundError } from '../utils/errors';

const router = Router();

router.get('/plans', async (_req: Request, res: Response) => {
  const plans = await prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { frequencyWeeks: 'asc' },
  });
  res.json({ success: true, data: plans });
});

router.use(requireCustomerAuth);

router.get('/', async (req: Request, res: Response) => {
  const subscriptions = await prisma.subscription.findMany({
    where: { customerId: req.customer!.id },
    include: {
      plan: true,
      items: { include: { product: { include: { images: true } }, variant: true } },
      history: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: subscriptions });
});

router.post('/', validate(subscriptionCreateSchema), async (req: Request, res: Response) => {
  const { planId, variantId, quantity, shippingAddressJson } = req.body;
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new NotFoundError('Subscription plan not found');

  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true },
  });
  if (!variant) throw new NotFoundError('Product variant not found');

  const nextDate = new Date(Date.now() + plan.frequencyWeeks * 7 * 24 * 60 * 60 * 1000);

  const sub = await prisma.subscription.create({
    data: {
      customerId: req.customer!.id,
      planId: plan.id,
      status: 'ACTIVE',
      discountPercent: plan.discountPercent,
      nextBillingDate: nextDate,
      nextDeliveryDate: nextDate,
      shippingAddressJson: shippingAddressJson as object,
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

router.post('/:id/pause', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const sub = await prisma.subscription.findFirst({ where: { id, customerId: req.customer!.id } });
  if (!sub) throw new NotFoundError('Subscription not found');

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: 'PAUSED',
      history: { create: { event: 'PAUSED', details: 'Paused by customer' } },
    },
  });
  res.json({ success: true, data: updated });
});

router.post('/:id/resume', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const sub = await prisma.subscription.findFirst({ where: { id, customerId: req.customer!.id } });
  if (!sub) throw new NotFoundError('Subscription not found');

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: 'ACTIVE',
      history: { create: { event: 'RESUMED', details: 'Resumed by customer' } },
    },
  });
  res.json({ success: true, data: updated });
});

router.post('/:id/skip', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const sub = await prisma.subscription.findFirst({
    where: { id, customerId: req.customer!.id },
    include: { plan: true },
  });
  if (!sub) throw new NotFoundError('Subscription not found');

  const shifted = new Date(
    sub.nextDeliveryDate.getTime() + sub.plan.frequencyWeeks * 7 * 24 * 60 * 60 * 1000
  );

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      nextDeliveryDate: shifted,
      nextBillingDate: shifted,
      history: { create: { event: 'SKIPPED', details: 'Skipped next delivery cycle' } },
    },
  });
  res.json({ success: true, data: updated });
});

router.post('/:id/cancel', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const sub = await prisma.subscription.findFirst({ where: { id, customerId: req.customer!.id } });
  if (!sub) throw new NotFoundError('Subscription not found');

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      history: { create: { event: 'CANCELLED', details: 'Cancelled by customer' } },
    },
  });
  res.json({ success: true, data: updated });
});

export default router;
