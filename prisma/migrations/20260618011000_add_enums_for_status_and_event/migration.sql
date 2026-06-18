-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('INITIALIZED', 'AUTHORIZED', 'CONFIRMED', 'REJECTED', 'FAILED', 'ABORTED', 'REVERSED', 'POLLED');

-- CreateEnum
CREATE TYPE "AuditEvent" AS ENUM ('INITIALIZED', 'AUTHORIZED', 'CONFIRMED', 'ABORTED', 'REJECTED', 'REVERSED', 'POLLED', 'MARKED_FAILED');

-- AlterTable: Convert status column from varchar to enum
ALTER TABLE "webpay_transactions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "webpay_transactions" ALTER COLUMN "status" TYPE "TransactionStatus" USING "status"::"TransactionStatus";
ALTER TABLE "webpay_transactions" ALTER COLUMN "status" SET DEFAULT 'INITIALIZED';

-- AlterTable: Convert event column from varchar to enum
ALTER TABLE "transaction_audit_log" ALTER COLUMN "event" TYPE "AuditEvent" USING "event"::"AuditEvent";
