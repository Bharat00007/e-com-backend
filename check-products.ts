import { prisma } from './src/config/prisma';

async function main() {
  const count = await prisma.product.count();
  const products = await prisma.product.findMany({
    include: { variants: true, images: true, category: true },
  });
  console.log('PRODUCT_COUNT_IN_DB:', count);
  console.log('PRODUCTS:', JSON.stringify(
    products.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      status: p.status,
      category: p.category.name,
      variantsCount: p.variants.length,
      variants: p.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        label: v.packSizeLabel,
        price: v.price,
        stockQuantity: v.stockQuantity,
      })),
      imagesCount: p.images.length,
      images: p.images.map((i) => i.url),
    })),
    null,
    2
  ));
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
