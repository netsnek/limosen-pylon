-- CreateTable
CREATE TABLE "Transfer" (
    "transferId" TEXT NOT NULL PRIMARY KEY,
    "rideDateISO" TEXT NOT NULL,
    "rideTime" TEXT NOT NULL,
    "pickup" TEXT NOT NULL,
    "dropoff" TEXT NOT NULL,
    "roomOrName" TEXT,
    "vehicle" TEXT,
    "amountEUR" REAL,
    "payment" TEXT,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT,
    "driverId" TEXT,
    "driverName" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "requestedAtISO" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtISO" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Transfer_rideDateISO_idx" ON "Transfer"("rideDateISO");

-- CreateIndex
CREATE INDEX "Transfer_customerId_idx" ON "Transfer"("customerId");

-- CreateIndex
CREATE INDEX "Transfer_driverId_idx" ON "Transfer"("driverId");

-- CreateIndex
CREATE INDEX "Transfer_state_idx" ON "Transfer"("state");
