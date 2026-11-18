-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "refreshTokenEncrypted" TEXT;
