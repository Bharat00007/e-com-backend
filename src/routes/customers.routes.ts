import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { requireCustomerAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { addressSchema, customerProfileUpdateSchema, normalizeIndianMobile } from '../validators/schemas';
import { ConflictError, NotFoundError } from '../utils/errors';

const router = Router();

router.use(requireCustomerAuth);

router.get('/me', async (req: Request, res: Response) => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.customer!.id },
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

router.patch('/me', validate(customerProfileUpdateSchema), async (req: Request, res: Response) => {
  const { fullName, phone, marketingConsent } = req.body as {
    fullName?: string;
    phone?: string;
    marketingConsent?: boolean;
  };
  const normalizedPhone = phone ? normalizeIndianMobile(phone) : undefined;
  if (normalizedPhone) {
    const existing = await prisma.customer.findUnique({ where: { phone: normalizedPhone } });
    if (existing && existing.id !== req.customer!.id) {
      throw new ConflictError('An account with this mobile number already exists');
    }
  }
  const updated = await prisma.customer.update({
    where: { id: req.customer!.id },
    data: {
      ...(fullName ? { fullName: fullName.trim() } : {}),
      ...(normalizedPhone ? { phone: normalizedPhone } : {}),
      ...(marketingConsent !== undefined ? { marketingConsent } : {}),
    },
    select: { id: true, fullName: true, email: true, phone: true, marketingConsent: true },
  });
  res.json({ success: true, data: updated });
});

router.get('/addresses', async (req: Request, res: Response) => {
  const addresses = await prisma.address.findMany({
    where: { customerId: req.customer!.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  res.json({ success: true, data: addresses });
});

router.post('/addresses', validate(addressSchema), async (req: Request, res: Response) => {
  const data = req.body;
  if (data.isDefault) {
    await prisma.address.updateMany({
      where: { customerId: req.customer!.id },
      data: { isDefault: false },
    });
  }
  const address = await prisma.address.create({
    data: { ...data, customerId: req.customer!.id },
  });
  res.status(201).json({ success: true, data: address });
});

router.patch('/addresses/:id', validate(addressSchema), async (req: Request, res: Response) => {
  const addressId = String(req.params.id);
  const existing = await prisma.address.findFirst({
    where: { id: addressId, customerId: req.customer!.id },
  });
  if (!existing) throw new NotFoundError('Address not found');

  if (req.body.isDefault) {
    await prisma.address.updateMany({
      where: { customerId: req.customer!.id },
      data: { isDefault: false },
    });
  }

  const updated = await prisma.address.update({
    where: { id: existing.id },
    data: req.body,
  });
  res.json({ success: true, data: updated });
});

router.delete('/addresses/:id', async (req: Request, res: Response) => {
  const addressId = String(req.params.id);
  const existing = await prisma.address.findFirst({
    where: { id: addressId, customerId: req.customer!.id },
  });
  if (!existing) throw new NotFoundError('Address not found');

  await prisma.address.delete({ where: { id: existing.id } });
  res.json({ success: true, message: 'Address deleted' });
});

export default router;
