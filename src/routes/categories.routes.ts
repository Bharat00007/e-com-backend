import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const categories = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    include: { _count: { select: { products: true } } },
  });
  res.json({ success: true, data: categories });
});

export default router;
