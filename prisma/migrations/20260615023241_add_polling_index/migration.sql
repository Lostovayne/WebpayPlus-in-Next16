-- CreateIndex
CREATE INDEX "webpay_transactions_status_created_at_polled_at_idx" ON "webpay_transactions"("status", "created_at", "polled_at");
