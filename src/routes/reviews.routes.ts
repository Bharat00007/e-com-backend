import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { requireCustomerAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { reviewCreateSchema } from '../validators/schemas';

const router = Router();

router.get('/product/:productId', async (req: Request, res: Response) => {
  const productId = String(req.params.productId);
  const reviews = await prisma.review.findMany({
    where: { productId, status: 'APPROVED' },
    include: { customer: { select: { fullName: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: reviews });
});

router.post('/', requireCustomerAuth, validate(reviewCreateSchema), async (req: Request, res: Response) => {
  const { productId, rating, title, comment } = req.body;
  const review = await prisma.review.upsert({
    where: { productId_customerId: { productId, customerId: req.customer!.id } },
    update: { rating, title, comment, status: 'APPROVED' },
    create: {
      productId,
      customerId: req.customer!.id,
      rating,
      title,
      comment,
      status: 'APPROVED',
    },
  });
  res.status(201).json({ success: true, data: review });
});

export default router;
