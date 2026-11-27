import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { requireCustomerAuth } from '../middleware/auth';
import { BadRequestError, NotFoundError } from '../utils/errors';

const router = Router();
router.use(requireCustomerAuth);

/**
 * GET /api/v1/wishlist
 * Returns the authenticated customer's full wishlist with product details.
 */
router.get('/', async (req: Request, res: Response) => {
  const customerId = req.customer!.id;

  const wishlist = await prisma.wishlist.findUnique({
    where: { customerId },
    include: {
      items: {
        include: {
          product: {
            include: {
              images: { orderBy: { isPrimary: 'desc' } },
              variants: { where: { isAvailable: true } },
              category: { select: { id: true, name: true, slug: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!wishlist) {
    return res.json({
      success: true,
      data: {
        id: null,
        customerId,
        items: [],
      },
    });
  }

  // Safely filter out items where product may have been soft-deleted/archived
  const activeItems = wishlist.items.filter(
    (item) => item.product && item.product.status === 'ACTIVE'
  );

  res.json({
    success: true,
    data: {
      ...wishlist,
      items: activeItems,
    },
  });
});

/**
 * POST /api/v1/wishlist/toggle
 * Toggles product addition / removal in customer's wishlist.
 */
router.post('/toggle', async (req: Request, res: Response) => {
  const customerId = req.customer!.id;
  const { productId } = req.body as { productId?: string };

  if (!productId) {
    throw new BadRequestError('productId is required');
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, status: true },
  });

  if (!product || product.status !== 'ACTIVE') {
    throw new NotFoundError('Product not found or currently unavailable');
  }

  const wishlist = await prisma.wishlist.upsert({
    where: { customerId },
    update: {},
    create: { customerId },
  });

  const existing = await prisma.wishlistItem.findUnique({
    where: { wishlistId_productId: { wishlistId: wishlist.id, productId } },
  });

  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });
    return res.json({
      success: true,
      data: { added: false, productId, message: 'Product removed from wishlist' },
    });
  }

  await prisma.wishlistItem.create({
    data: { wishlistId: wishlist.id, productId },
  });

  res.status(201).json({
    success: true,
    data: { added: true, productId, message: 'Product added to wishlist' },
  });
});

/**
 * POST /api/v1/wishlist/merge
 * Merges an array of product IDs saved by a guest into the customer's authenticated wishlist.
 */
router.post('/merge', async (req: Request, res: Response) => {
  const customerId = req.customer!.id;
  const { productIds } = req.body as { productIds?: string[] };

  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.json({
      success: true,
      data: { mergedCount: 0, productIds: [] },
    });
  }

  // Filter valid, existing active products
  const validProducts = await prisma.product.findMany({
    where: {
      id: { in: productIds },
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  const validIds = validProducts.map((p) => p.id);

  if (validIds.length === 0) {
    return res.json({
      success: true,
      data: { mergedCount: 0, productIds: [] },
    });
  }

  const wishlist = await prisma.wishlist.upsert({
    where: { customerId },
    update: {},
    create: { customerId },
  });

  // Find existing items to prevent duplicates
  const existingItems = await prisma.wishlistItem.findMany({
    where: {
      wishlistId: wishlist.id,
      productId: { in: validIds },
    },
    select: { productId: true },
  });

  const existingSet = new Set(existingItems.map((i) => i.productId));
  const toAdd = validIds.filter((id) => !existingSet.has(id));

  if (toAdd.length > 0) {
    await prisma.wishlistItem.createMany({
      data: toAdd.map((productId) => ({
        wishlistId: wishlist.id,
        productId,
      })),
      skipDuplicates: true,
    });
  }

  const allItems = await prisma.wishlistItem.findMany({
    where: { wishlistId: wishlist.id },
    select: { productId: true },
  });

  res.json({
    success: true,
    data: {
      mergedCount: toAdd.length,
      productIds: allItems.map((i) => i.productId),
    },
  });
});

/**
 * POST /api/v1/wishlist/:productId
 * Adds a product to customer's wishlist.
 */
router.post('/:productId', async (req: Request, res: Response) => {
  const customerId = req.customer!.id;
  const productId = String(req.params.productId);

  if (!productId || productId === 'undefined') {
    throw new BadRequestError('Valid productId is required');
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, status: true },
  });

  if (!product || product.status !== 'ACTIVE') {
    throw new NotFoundError('Product not found or currently unavailable');
  }

  const wishlist = await prisma.wishlist.upsert({
    where: { customerId },
    update: {},
    create: { customerId },
  });

  const existing = await prisma.wishlistItem.findUnique({
    where: { wishlistId_productId: { wishlistId: wishlist.id, productId } },
  });

  if (!existing) {
    await prisma.wishlistItem.create({
      data: { wishlistId: wishlist.id, productId },
    });
  }

  res.status(201).json({
    success: true,
    data: {
      added: true,
      productId,
      message: 'Product added to wishlist',
    },
  });
});

/**
 * DELETE /api/v1/wishlist/:productId
 * Removes a product from customer's wishlist.
 */
router.delete('/:productId', async (req: Request, res: Response) => {
  const customerId = req.customer!.id;
  const productId = String(req.params.productId);

  if (!productId || productId === 'undefined') {
    throw new BadRequestError('Valid productId is required');
  }

  const wishlist = await prisma.wishlist.findUnique({
    where: { customerId },
  });

  if (wishlist) {
    await prisma.wishlistItem.deleteMany({
      where: {
        wishlistId: wishlist.id,
        productId,
      },
    });
  }

  res.json({
    success: true,
    data: {
      removed: true,
      productId,
      message: 'Product removed from wishlist',
    },
  });
});

export default router;
