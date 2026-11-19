-- CreateTable
CREATE TABLE "OrderCreateRequest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "shopifyOrderId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCreateRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderCreateRequest_shopId_requestKey_key" ON "OrderCreateRequest"("shopId", "requestKey");

-- AddForeignKey
ALTER TABLE "OrderCreateRequest" ADD CONSTRAINT "OrderCreateRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
