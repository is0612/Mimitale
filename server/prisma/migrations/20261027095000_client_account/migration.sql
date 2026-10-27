-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "avatar" TEXT,
ADD COLUMN     "password_hash" TEXT,
ADD COLUMN     "profile_ready" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "voucher" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "customers_voucher_key" ON "customers"("voucher");
