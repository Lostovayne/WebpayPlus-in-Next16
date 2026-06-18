-- Create new TransactionStatus enum without CONFIRMED and POLLED
CREATE TYPE "TransactionStatus_new" AS ENUM ('INITIALIZED', 'AUTHORIZED', 'REJECTED', 'FAILED', 'ABORTED', 'REVERSED');

-- Migrate data: map any CONFIRMED → AUTHORIZED, POLLED → INITIALIZED (safest fallback)
UPDATE "webpay_transactions" SET "status" = 'AUTHORIZED' WHERE "status" = 'CONFIRMED';
UPDATE "webpay_transactions" SET "status" = 'INITIALIZED' WHERE "status" = 'POLLED';

-- Drop old column default, alter type, set new default
ALTER TABLE "webpay_transactions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "webpay_transactions" ALTER COLUMN "status" TYPE "TransactionStatus_new" USING "status"::text::"TransactionStatus_new";
ALTER TABLE "webpay_transactions" ALTER COLUMN "status" SET DEFAULT 'INITIALIZED';

-- Drop old enum and rename new
DROP TYPE "TransactionStatus";
ALTER TYPE "TransactionStatus_new" RENAME TO "TransactionStatus";
