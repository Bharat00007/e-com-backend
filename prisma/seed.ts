import { PrismaClient, PetCategory, ProductStatus, DiscountType, AdminRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding The Sniff Co. PostgreSQL database...');

  // 1. Categories
  const catLitterCategory = await prisma.category.upsert({
    where: { slug: 'cat-litter' },
    update: {},
    create: {
      name: 'Cat Litter',
      slug: 'cat-litter',
      description: 'Low-dust clumping bentonite cat litter with activated carbon.',
      sortOrder: 1,
    },
  });

  const groomingCategory = await prisma.category.upsert({
    where: { slug: 'grooming' },
    update: {},
    create: {
      name: 'Grooming',
      slug: 'grooming',
      description: 'Gentle plant-powered shampoos, dry foams, and bamboo wipes.',
      sortOrder: 2,
    },
  });

  const homeCareCategory = await prisma.category.upsert({
    where: { slug: 'home-care' },
    update: {},
    create: {
      name: 'Home Care',
      slug: 'home-care',
      description: 'Odour neutralizers for litter trays and pet bedding.',
      sortOrder: 3,
    },
  });

  // 2. Products & Variants
  const productsSeed = [
    {
      slug: 'clumping-cat-litter',
      name: 'Clumping Cat Litter with Activated Carbon',
      shortName: 'Clumping Cat Litter',
      kicker: 'For Cats · Low-dust',
      subtitle: 'Activated carbon · 5 kg',
      description:
        'Pure Indian sodium bentonite blended with micro-porous activated carbon. Locks ammonia odours in seconds without synthetic perfumes or respiratory dust.',
      categoryId: catLitterCategory.id,
      petCategory: PetCategory.CATS,
      badge: 'Bestseller',
      secondaryBadge: 'Made in India',
      features: ['Activated Carbon', 'Fragrance Free'],
      isFeatured: true,
      isBestseller: true,
      ratingAverage: 4.9,
      reviewCount: 186,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuBiEPyx6StPsb0Go3rmjSZdVRIO9tePi9rO682ZTB_MewYwE2iTLu8JAd-dlW4Ea0nXBxMgudjb5oGFwcKf-zVxY4ZrUgQMJgOSgmzI6t7gXvUnL30Ig4YZCTfcCyCu19LwS-FVLPxcJ3ooCoL0Q5_Pd6Jh6atJwcX1g3h_GcxCASBBRzkrTYKBqoi-wKOZvvgqb30UJBfSgPXaUxBbwNNtFqhQ1JIzhVTgDiOjkMzz',
      variants: [
        {
          sku: 'SNC-LITTER-5KG',
          packSizeLabel: '5 kg',
          weightGrams: 5000,
          price: 699,
          salePrice: null,
          pricePerUnit: 'Incl. of all taxes',
          stockQuantity: 120,
          isDefault: true,
        },
        {
          sku: 'SNC-LITTER-10KG',
          packSizeLabel: '10 kg',
          weightGrams: 10000,
          price: 1199,
          salePrice: null,
          pricePerUnit: '₹120 / kg',
          stockQuantity: 85,
          isDefault: false,
        },
      ],
    },
    {
      slug: 'clumping-cat-litter-10kg',
      name: 'Clumping Cat Litter (10 kg Pack)',
      shortName: 'Clumping Cat Litter (10 kg)',
      kicker: 'For Cats · Bulk Economy',
      subtitle: 'Lasts up to 8 weeks for a single companion cat.',
      description:
        'Value twin-capacity pack of our signature 99.9% dust-free bentonite clumping litter with natural activated charcoal.',
      categoryId: catLitterCategory.id,
      petCategory: PetCategory.CATS,
      badge: 'Best Value',
      secondaryBadge: 'Save ₹200',
      features: ['Activated Carbon', 'Fragrance Free'],
      isFeatured: true,
      isBestseller: true,
      ratingAverage: 4.9,
      reviewCount: 94,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuBfqjl2p_6JT84Qmnf7_qNj4XWkRPodPSoa4n9MLnW8DI8ElB5MKpVF38hCWMm0Dsq0ER5HFMjpDQekq1ijayksmo05cfekkMBW2yyORABHTaGKwPl2uT8USDuG7f37zrxDA_9bTva1h2j3jpn3NHN_3biDMkBGf-zs2daDBpg6RhZCu4CWmIZjkmdGK-FRlvGsFLSLFEh4Th-qrIl9ve5e9Mb4P8vWYDwf6NNIoGjB',
      variants: [
        {
          sku: 'SNC-LITTER-BULK-10KG',
          packSizeLabel: '10 kg',
          weightGrams: 10000,
          price: 1199,
          salePrice: null,
          pricePerUnit: '₹120 / kg',
          stockQuantity: 90,
          isDefault: true,
        },
      ],
    },
    {
      slug: 'soft-silky-dog-shampoo',
      name: 'Soft & Silky Shampoo for Dogs',
      shortName: 'Soft & Silky Shampoo',
      kicker: 'For Dogs · 200 ml',
      subtitle: 'Colloidal oatmeal & aloe vera for sensitive skin.',
      description:
        'pH-balanced botanical cleanser with colloidal oatmeal, soothing aloe vera, and zero harsh sulfates or parabens.',
      categoryId: groomingCategory.id,
      petCategory: PetCategory.DOGS,
      badge: 'New',
      secondaryBadge: null,
      features: ['Fragrance Free'],
      isFeatured: true,
      isBestseller: true,
      ratingAverage: 4.8,
      reviewCount: 82,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuAYc6m2uT8AqbmmzWjlP8SUL3qVAKl-Qv47JSkBraAKg2-74gx1Qu3vXa9KgTpWj7Mqtura5iSsBkSn2-j_uY_39RMv9r6d-N_cuNFCh1n07x6SZx2drZthf03c6KA_prOaG7i_ex1vLOFs2j_NGBPWVU0iMw3Jh9Y1e1VhjHaFnxSUXWt0xbA7rxJVxyPgFw7zuX8WQuPZJixFEC__JAM_e_S9fUm9Xqg-PKbVRJeV',
      variants: [
        {
          sku: 'SNC-SHAMPOO-200ML',
          packSizeLabel: '200 ml',
          weightGrams: 220,
          price: 399,
          salePrice: null,
          pricePerUnit: 'Incl. of all taxes',
          stockQuantity: 150,
          isDefault: true,
        },
      ],
    },
    {
      slug: 'waterless-dry-foam-shampoo',
      name: 'Waterless Dry Foam Shampoo',
      shortName: 'Dry Shampoo',
      kicker: 'Cats & Dogs · 150 ml',
      subtitle: 'Stress-free cleansing between baths. No water needed.',
      description:
        'Gentle no-rinse foaming cleanser formulated for both cats and dogs. Lifts dirt and dander effortlessly.',
      categoryId: groomingCategory.id,
      petCategory: PetCategory.BOTH,
      badge: 'No-rinse',
      secondaryBadge: null,
      features: ['No-Rinse / Waterless', 'Fragrance Free'],
      isFeatured: false,
      isBestseller: true,
      ratingAverage: 4.7,
      reviewCount: 65,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuCIz2bRQJXQrtnBCJhxXF9fATO_dOSd6-dMSWBWzmsVK3s_ypPlLB9N2k4tqGjVDEVFyhCQvw6NTd4GM_8pqsiZwY4S5UCZWgX96knCEMLOqqrRWrMih7cgHLwJ8K--M27O_hX1SNKUEJOBV7BTvY2YquhtxfyzeVfQvkVnBUnoPmkAofszsZ7THXIrdbBYCEXl76KBhN-uz8ugy8t5HAkDaJn5gssiLZdLmHtjy8LV',
      variants: [
        {
          sku: 'SNC-DRYFOAM-150ML',
          packSizeLabel: '150 ml',
          weightGrams: 175,
          price: 349,
          salePrice: null,
          pricePerUnit: 'Incl. of all taxes',
          stockQuantity: 110,
          isDefault: true,
        },
      ],
    },
    {
      slug: 'odour-eliminator-spray',
      name: 'Activated Carbon Odour Eliminator Spray',
      shortName: 'Odour Eliminator Spray',
      kicker: 'Home Care · 250 ml',
      subtitle: 'Neutralises urine ammonia without chemical perfumes.',
      description:
        'Fine mist botanical & carbon-powered spray safe for litter boxes, pet bedding, and upholstery.',
      categoryId: homeCareCategory.id,
      petCategory: PetCategory.BOTH,
      badge: 'Odour Control',
      secondaryBadge: null,
      features: ['Activated Carbon', 'Fragrance Free'],
      isFeatured: false,
      isBestseller: false,
      ratingAverage: 4.9,
      reviewCount: 41,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuCib2xEnm1EjitraeZ-MBjkjMpEDBLJHPFpeJ40IMxjM4HjOEH_znNpRHtmckfKHEwiFxla3xEzBCUqEk4Sk6fxpeBMVqHJf5WbWANIPn6BTaZ26RN186b1CitphYMh4QXYDReyyG_-6AUlsdZL3ivXCQSPuod_3T7Aqu9JrxUeWjuFSDEu64VRfxeWtW1ZL0DXFvbjaUe5Ujge4ClfN0KaouR47IRz4FrtEJL3JOoR',
      variants: [
        {
          sku: 'SNC-SPRAY-250ML',
          packSizeLabel: '250 ml',
          weightGrams: 270,
          price: 449,
          salePrice: null,
          pricePerUnit: 'Incl. of all taxes',
          stockQuantity: 75,
          isDefault: true,
        },
      ],
    },
    {
      slug: 'bamboo-pet-wipes',
      name: 'Ultra-Soft Bamboo Pet Wipes',
      shortName: 'Bamboo Pet Wipes',
      kicker: 'Grooming & Paws · 80 Count',
      subtitle: 'Hypoallergenic chamomile & vitamin E for daily paw wipes.',
      description:
        'Compostable bamboo fiber wipes infused with soothing chamomile and vitamin E for muddy paws and quick coat refreshes.',
      categoryId: groomingCategory.id,
      petCategory: PetCategory.BOTH,
      badge: 'Biodegradable',
      secondaryBadge: null,
      features: ['Biodegradable', 'No-Rinse / Waterless'],
      isFeatured: false,
      isBestseller: false,
      ratingAverage: 4.8,
      reviewCount: 53,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuBg5zhzp3PH9EjtFeyNrVlZSHIhelOMmPIUXbdlVVJzsIQmxu5999WExA1XqNjvA9DFjQw7RDhIFEM2TZorxwbuGj3QNaZMwf7iydLjrCG_HxNEHY0BjM5CVlVPc1y3EPmOVTxN3uh2fH7zxvbJuPfGwAU3pNrMtP9gIy1vgPGtbX_1v0tm8JxNAvxogh11VOFg0IuQjIC45-FuGGhR9SRhMHIoOP62J5EXOUEnktZZ',
      variants: [
        {
          sku: 'SNC-WIPES-80CT',
          packSizeLabel: '80 wipes',
          weightGrams: 320,
          price: 299,
          salePrice: null,
          pricePerUnit: 'Incl. of all taxes',
          stockQuantity: 200,
          isDefault: true,
        },
      ],
    },
  ];

  for (const p of productsSeed) {
    const product = await prisma.product.upsert({
      where: { slug: p.slug },
      update: {
        name: p.name,
        shortName: p.shortName,
        kicker: p.kicker,
        subtitle: p.subtitle,
        description: p.description,
        badge: p.badge,
        secondaryBadge: p.secondaryBadge,
        features: p.features,
        isFeatured: p.isFeatured,
        isBestseller: p.isBestseller,
        ratingAverage: p.ratingAverage,
        reviewCount: p.reviewCount,
        status: ProductStatus.ACTIVE,
      },
      create: {
        slug: p.slug,
        name: p.name,
        shortName: p.shortName,
        kicker: p.kicker,
        subtitle: p.subtitle,
        description: p.description,
        categoryId: p.categoryId,
        petCategory: p.petCategory,
        badge: p.badge,
        secondaryBadge: p.secondaryBadge,
        features: p.features,
        isFeatured: p.isFeatured,
        isBestseller: p.isBestseller,
        ratingAverage: p.ratingAverage,
        reviewCount: p.reviewCount,
        status: ProductStatus.ACTIVE,
      },
    });

    // Ensure variants exist idempotently
    for (const v of p.variants) {
      await prisma.productVariant.upsert({
        where: { sku: v.sku },
        update: {
          productId: product.id,
          packSizeLabel: v.packSizeLabel,
          weightGrams: v.weightGrams,
          price: v.price,
          salePrice: v.salePrice,
          pricePerUnit: v.pricePerUnit,
          stockQuantity: v.stockQuantity,
          isAvailable: true,
          isDefault: v.isDefault,
        },
        create: {
          productId: product.id,
          sku: v.sku,
          packSizeLabel: v.packSizeLabel,
          weightGrams: v.weightGrams,
          price: v.price,
          salePrice: v.salePrice,
          pricePerUnit: v.pricePerUnit,
          stockQuantity: v.stockQuantity,
          isAvailable: true,
          isDefault: v.isDefault,
        },
      });
    }

    // Ensure primary image exists idempotently
    const existingImg = await prisma.productImage.findFirst({
      where: { productId: product.id, url: p.imageUrl },
    });
    if (!existingImg) {
      await prisma.productImage.create({
        data: {
          productId: product.id,
          url: p.imageUrl,
          altText: p.name,
          isPrimary: true,
          sortOrder: 0,
        },
      });
    }

    console.log(`Seeded product: ${product.slug}`);
  }

  // 3. Subscription Plans
  for (const plan of [
    { name: 'Every 3 Weeks', frequencyWeeks: 3, discountPercent: 15, description: 'Ideal for multi-cat homes' },
    { name: 'Every 4 Weeks', frequencyWeeks: 4, discountPercent: 15, description: 'Recommended for 1 cat' },
    { name: 'Every 6 Weeks', frequencyWeeks: 6, discountPercent: 15, description: 'Light usage' },
  ]) {
    await prisma.subscriptionPlan.upsert({
      where: { frequencyWeeks: plan.frequencyWeeks },
      update: {},
      create: plan,
    });
  }

  // 4. Coupons
  await prisma.coupon.upsert({
    where: { code: 'SNIFF10' },
    update: {},
    create: {
      code: 'SNIFF10',
      description: '10% off your order',
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      minOrderValue: 499,
      isActive: true,
    },
  });

  await prisma.coupon.upsert({
    where: { code: 'SNIFFFIRST10' },
    update: {},
    create: {
      code: 'SNIFFFIRST10',
      description: '10% extra first-order concession',
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      minOrderValue: 499,
      isActive: true,
    },
  });

  await prisma.coupon.upsert({
    where: { code: 'SNIFF15' },
    update: {},
    create: {
      code: 'SNIFF15',
      description: '15% off first newsletter order',
      discountType: DiscountType.PERCENTAGE,
      discountValue: 15,
      minOrderValue: 499,
      isActive: true,
    },
  });

  // 5. Optional Demo Customer & Bootstrap Admin (explicit opt-in only)
  if (process.env.SEED_DEMO_CUSTOMER === 'true') {
    const customerPassHash = await bcrypt.hash('SniffParent@2026', 12);
    await prisma.customer.upsert({
      where: { email: 'aarav.sharma@example.in' },
      update: {},
      create: {
        fullName: 'Aarav Sharma',
        email: 'aarav.sharma@example.in',
        phone: '9820000001',
        passwordHash: customerPassHash,
        emailVerified: true,
        marketingConsent: true,
        addresses: {
          create: [
            {
              label: 'Home',
              recipientName: 'Aarav Sharma',
              phone: '9820000001',
              addressLine1: 'Flat 402, Green Meadows, North Main Road',
              addressLine2: "Near Jogger's Park, Koregaon Park",
              city: 'Pune',
              state: 'Maharashtra',
              pincode: '411001',
              isDefault: true,
            },
          ],
        },
      },
    });
    console.log('Seeded optional development demo customer (SEED_DEMO_CUSTOMER=true).');
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD?.trim();
  if (adminEmail && adminPassword && adminPassword.length >= 12) {
    const adminPassHash = await bcrypt.hash(adminPassword, 12);
    await prisma.adminUser.upsert({
      where: { email: adminEmail.toLowerCase() },
      update: {},
      create: {
        fullName: 'The Sniff Co. Admin',
        email: adminEmail.toLowerCase(),
        passwordHash: adminPassHash,
        role: AdminRole.SUPER_ADMIN,
        permissions: ['*'],
      },
    });
    console.log(`Seeded admin account: ${adminEmail.toLowerCase()}`);
  }

  console.log('Seed completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
