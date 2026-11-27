-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "email" DROP NOT NULL;
