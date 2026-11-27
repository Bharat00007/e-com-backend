"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const prisma_1 = require("../config/prisma");
const errors_1 = require("../utils/errors");
const router = (0, express_1.Router)();
router.get('/', async (req, res) => {
    const { search, category, petCategory, minPrice, maxPrice, sort = 'featured', page = '1', limit = '20', } = req.query;
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(50, Math.max(1, Number(limit) || 20));
    const skip = (pageNum - 1) * limitNum;
    const where = { status: 'ACTIVE' };
    if (search?.trim()) {
        where.OR = [
            { name: { contains: search.trim(), mode: 'insensitive' } },
            { subtitle: { contains: search.trim(), mode: 'insensitive' } },
            { description: { contains: search.trim(), mode: 'insensitive' } },
        ];
    }
    if (category && category !== 'all') {
        if (category === 'cats') {
            where.petCategory = { in: [client_1.PetCategory.CATS, client_1.PetCategory.BOTH] };
        }
        else if (category === 'dogs') {
            where.petCategory = { in: [client_1.PetCategory.DOGS, client_1.PetCategory.BOTH] };
        }
        else {
            where.category = { slug: category };
        }
    }
    if (petCategory && ['CATS', 'DOGS', 'BOTH'].includes(petCategory.toUpperCase())) {
        where.petCategory = petCategory.toUpperCase();
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
    const orderBy = sort === 'bestsellers'
        ? { reviewCount: 'desc' }
        : sort === 'rating'
            ? { ratingAverage: 'desc' }
            : { isFeatured: 'desc' };
    const products = await prisma_1.prisma.product.findMany({
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
    const total = pageNum === 1 && products.length < limitNum
        ? products.length
        : await prisma_1.prisma.product.count({ where });
    res.json({
        success: true,
        data: products,
        meta: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
});
router.get('/featured', async (_req, res) => {
    const products = await prisma_1.prisma.product.findMany({
        where: { status: 'ACTIVE', isFeatured: true },
        include: { category: true, images: true, variants: true },
    });
    res.json({ success: true, data: products });
});
router.get('/bestsellers', async (_req, res) => {
    const products = await prisma_1.prisma.product.findMany({
        where: { status: 'ACTIVE', isBestseller: true },
        include: { category: true, images: true, variants: true },
        orderBy: { reviewCount: 'desc' },
    });
    res.json({ success: true, data: products });
});
router.get('/:slug', async (req, res) => {
    const slug = String(req.params.slug);
    const product = await prisma_1.prisma.product.findUnique({
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
    if (!product)
        throw new errors_1.NotFoundError('Product not found');
    res.json({ success: true, data: product });
});
router.get('/:slug/related', async (req, res) => {
    const slug = String(req.params.slug);
    const product = await prisma_1.prisma.product.findUnique({ where: { slug } });
    if (!product)
        throw new errors_1.NotFoundError('Product not found');
    const related = await prisma_1.prisma.product.findMany({
        where: { status: 'ACTIVE', id: { not: product.id } },
        include: { images: true, variants: true },
        take: 3,
    });
    res.json({ success: true, data: related });
});
exports.default = router;
