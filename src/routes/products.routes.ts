import { Router, Request, Response } from 'express';
import { Prisma, PetCategory } from '@prisma/client';
import { prisma } from '../config/prisma';
import { NotFoundError } from '../utils/errors';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const {
    search,
    category,
    petCategory,
    minPrice,
    maxPrice,
    sort = 'featured',
    page = '1',
    limit = '20',
  } = req.query as Record<string, string | undefined>;

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * limitNum;

  const where: Prisma.ProductWhereInput = { status: 'ACTIVE' };

  if (search?.trim()) {
    where.OR = [
      { name: { contains: search.trim(), mode: 'insensitive' } },
      { subtitle: { contains: search.trim(), mode: 'insensitive' } },
      { description: { contains: search.trim(), mode: 'insensitive' } },
    ];
  }

  if (category && category !== 'all') {
    if (category === 'cats') {
      where.petCategory = { in: [PetCategory.CATS, PetCategory.BOTH] };
    } else if (category === 'dogs') {
      where.petCategory = { in: [PetCategory.DOGS, PetCategory.BOTH] };
    } else {
      where.category = { slug: category };
    }
  }

  if (petCategory && ['CATS', 'DOGS', 'BOTH'].includes(petCategory.toUpperCase())) {
    where.petCategory = petCategory.toUpperCase() as PetCategory;
  }

  if (minPrice || maxPrice) {
    where.variants = {
      some: {
        price: {
          ...(minPrice ? { gte: Number(minPrice) } : {}),
          ...(maxPrice ? { lte: Number(maxPrice) } : {}),
        },
      },
    };
  }

  const orderBy: Prisma.ProductOrderByWithRelationInput =
    sort === 'bestsellers'
      ? { reviewCount: 'desc' }
      : sort === 'rating'
        ? { ratingAverage: 'desc' }
        : { isFeatured: 'desc' };

  const products = await prisma.product.findMany({
    where,
    include: {
      category: true,
      images: { orderBy: { sortOrder: 'asc' } },
      variants: { orderBy: { price: 'asc' } },
    },
    orderBy,
    skip,
    take: limitNum,
  });

  const total =
    pageNum === 1 && products.length < limitNum
      ? products.length
      : await prisma.product.count({ where });

  res.json({
    success: true,
    data: products,
    meta: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
  });
});

router.get('/featured', async (_req: Request, res: Response) => {
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE', isFeatured: true },
    include: { category: true, images: true, variants: true },
  });
  res.json({ success: true, data: products });
});

router.get('/bestsellers', async (_req: Request, res: Response) => {
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE', isBestseller: true },
    include: { category: true, images: true, variants: true },
    orderBy: { reviewCount: 'desc' },
  });
  res.json({ success: true, data: products });
});

router.get('/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  const product = await prisma.product.findUnique({
    where: { slug },
    include: {
      category: true,
      images: { orderBy: { sortOrder: 'asc' } },
      variants: { orderBy: { price: 'asc' } },
      reviews: {
        where: { status: 'APPROVED' },
        include: { customer: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!product) throw new NotFoundError('Product not found');
  res.json({ success: true, data: product });
});

router.get('/:slug/related', async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  const product = await prisma.product.findUnique({ where: { slug } });
  if (!product) throw new NotFoundError('Product not found');

  const related = await prisma.product.findMany({
    where: { status: 'ACTIVE', id: { not: product.id } },
    include: { images: true, variants: true },
    take: 3,
  });
  res.json({ success: true, data: related });
});

export default router;
