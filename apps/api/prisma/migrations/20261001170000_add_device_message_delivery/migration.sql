-- CreateTable
CREATE TABLE "DeviceMessageDelivery" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceMessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceMessageDelivery_deviceId_messageId_key" ON "DeviceMessageDelivery"("deviceId", "messageId");
CREATE INDEX "DeviceMessageDelivery_deviceId_sequenceNumber_idx" ON "DeviceMessageDelivery"("deviceId", "sequenceNumber");
CREATE INDEX "DeviceMessageDelivery_messageId_idx" ON "DeviceMessageDelivery"("messageId");

-- AddForeignKey
ALTER TABLE "DeviceMessageDelivery" ADD CONSTRAINT "DeviceMessageDelivery_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceMessageDelivery" ADD CONSTRAINT "DeviceMessageDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
