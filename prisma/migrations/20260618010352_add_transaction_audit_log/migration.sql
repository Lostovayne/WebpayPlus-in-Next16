-- CreateTable
CREATE TABLE "transaction_audit_log" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "buy_order" VARCHAR(26) NOT NULL,
    "event" VARCHAR(50) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transaction_audit_log_transaction_id_idx" ON "transaction_audit_log"("transaction_id");

-- CreateIndex
CREATE INDEX "transaction_audit_log_buy_order_idx" ON "transaction_audit_log"("buy_order");

-- CreateIndex
CREATE INDEX "transaction_audit_log_event_created_at_idx" ON "transaction_audit_log"("event", "created_at");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
