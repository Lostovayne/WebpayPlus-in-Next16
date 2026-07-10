"use server";

import { env } from "@/shared/env";
import logger from "@/shared/lib/logger";
import { prisma } from "@/shared/lib/prisma";
import { AuditEvent, Prisma } from "generated/prisma";
import { WebpayTransaction } from "../domain/Transaction";
import { transactionRepository } from "../infrastructure/PrismaTransactionRepository";
import {
  TransbankAlreadyProcessedError,
  TransbankRefundAlreadyProcessedError,
  TransbankGateway,
} from "../infrastructure/TransbankGateway";

// Lazy singleton — allows test mocking via __setGatewayForTesting
let gateway: InstanceType<typeof TransbankGateway> | null = null;

function getGateway(): InstanceType<typeof TransbankGateway> {
  if (!gateway) gateway = new TransbankGateway();
  return gateway;
}

/**
 * Test-only: inject a mock gateway. Resets after each test.
 * @internal — blocked in production to prevent gateway hijacking
 */
export async function __setGatewayForTesting(mock: InstanceType<typeof TransbankGateway>): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setGatewayForTesting is not allowed in production");
  }
  gateway = mock;
}

export async function __resetGatewayForTesting(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__resetGatewayForTesting is not allowed in production");
  }
  gateway = null;
}

// ─── Audit Log Helper ──────────────────────────────────────────────────────

async function logAuditEvent(
  transactionId: string,
  buyOrder: string,
  event: AuditEvent,
  details?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await prisma.transactionAuditLog.create({
      data: {
        transactionId,
        buyOrder,
        event,
        ...(details ? { details } : {}),
      },
    });
  } catch (err) {
    // Audit log failure must NOT break the transaction flow
    logger.warn({ err, transactionId, buyOrder, event, tag: "audit_log_failed" }, "[Webpay] Failed to write audit log");
  }
}

// ─── Refund Helper: mark + save + audit ─────────────────────────────────────

/**
 * Marks a transaction as REVERSED, persists, and writes audit log.
 * Used for both direct success and 422 fallback paths.
 */
async function reverseTransaction(
  transaction: WebpayTransaction,
  auditDetails: Prisma.InputJsonValue,
): Promise<void> {
  transaction.markAsReversed();
  await transactionRepository.save(transaction);
  await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "REVERSED", auditDetails);
}

// ─── Helper: safe buy_order generation ────────────────────────────────────────

/**
 * Generates a unique, safe buy_order with max 26 characters.
 *
 * Why not Date.now()?
 * Date.now() can collide at millisecond level under concurrent load.
 * With 10 bytes of crypto we get 2^80 possibilities → practically impossible collision.
 *
 * Format: "BO" + 20 hex chars = 22 chars total (under Transbank's 26 limit).
 */
function generateBuyOrder(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `BO${hex}`.toUpperCase();
}

// ─── Use Case 1: Initiate Transaction ────────────────────────────────────────

/**
 * Creates a new Webpay transaction and redirects to the payment form.
 *
 * Operation order (do NOT change):
 * 1. Create domain entity in INITIALIZED state
 * 2. Persist to DB ← BEFORE touching the network
 * 3. Call Transbank → get token + URL
 * 4. Save token to DB
 * 5. Redirect user
 *
 * If Transbank fails at step 3, the transaction remains in DB as FAILED
 * and we have traceability. Without step 2 we'd lose the record entirely.
 */
export interface TransbankRedirectData {
  url: string;
  token: string;
}

export async function initiateTransactionAction(amount: number, idempotencyKey?: string): Promise<TransbankRedirectData> {
    if (amount <= 0) throw new Error("Invalid amount: must be greater than zero.");

  // Idempotency: when a key is provided, use it directly as the buyOrder
  // so subsequent calls with the same key find the existing transaction.
  let buyOrder: string;

  if (idempotencyKey) {
    if (idempotencyKey.length > 26 || !/^[A-Za-z0-9_-]+$/.test(idempotencyKey)) {
      throw new Error("Invalid idempotencyKey: max 26 alphanumeric characters.");
    }
    buyOrder = idempotencyKey;

    const existing = await transactionRepository.findByBuyOrder(idempotencyKey);
    if (existing) {
      if (existing.props.status === "INITIALIZED" && existing.props.token && existing.props.paymentUrl) {
        // Re-use existing transaction — return redirect data for POST form
        await logAuditEvent(existing.props.id, buyOrder, "INITIALIZED", { idempotent: true } as Prisma.InputJsonValue);
        return { url: existing.props.paymentUrl, token: existing.props.token };
      }
      if (existing.props.status === "INITIALIZED" && existing.props.token && !existing.props.paymentUrl) {
        // Token exists but paymentUrl missing (Transbank returned empty URL) — not redirectable
        throw new Error("Transaction in progress, try again in a few seconds.");
      }
      if (existing.props.status === "INITIALIZED" && !existing.props.token) {
        throw new Error("Transaction in progress, try again in a few seconds.");
      }
      // Terminal states — except FAILED, which is retryable
      // (FAILED = technical error on our side, Transbank was never called successfully)
      if (existing.isTerminal && existing.props.status !== "FAILED") {
        throw new Error("Transaction already processed.");
      }
      // FAILED status: fall through to create a new transaction (retry)
    }
  } else {
    buyOrder = generateBuyOrder();
  }

  const transaction = WebpayTransaction.initialize(buyOrder, crypto.randomUUID(), amount);

  // Persist BEFORE touching external network.
  // Catch P2002 (unique constraint) for race condition: two parallel calls
  // with same idempotencyKey may both reach here. The second save will fail
  // with P2002 — re-read and apply idempotency logic.
  try {
    await transactionRepository.save(transaction);
  } catch (err) {
    // Prisma v7: error code is in err.code, NOT in err.message
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Race condition: another request created the transaction first.
      // Re-read and apply idempotency logic.
      const raceExisting = await transactionRepository.findByBuyOrder(buyOrder);
      if (raceExisting) {
        if (raceExisting.props.status === "INITIALIZED" && raceExisting.props.token && raceExisting.props.paymentUrl) {
          await logAuditEvent(raceExisting.props.id, buyOrder, "INITIALIZED", { idempotent: true } as Prisma.InputJsonValue);
          return { url: raceExisting.props.paymentUrl, token: raceExisting.props.token };
        }
        // Terminal states (except FAILED) — cannot retry
        if (raceExisting.isTerminal && raceExisting.props.status !== "FAILED") {
          throw new Error("Transaction already processed.");
        }
        // INITIALIZED without token, or FAILED — retryable
      }
      throw new Error("Transaction in progress, try again in a few seconds.");
    }
    throw err;
  }

  await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "INITIALIZED", { amount } as Prisma.InputJsonValue);

  const returnUrl = `${env.NEXT_PUBLIC_APP_URL}/api/webpay/return`;

  let transbankUrl: string;
  let transbankToken: string;

  try {
    const tbkResponse = await getGateway().createTransaction(
      transaction.props.buyOrder,
      transaction.props.sessionId,
      transaction.props.amount,
      returnUrl,
    );

    transaction.setToken(tbkResponse.token);
    transaction.setPaymentUrl(tbkResponse.url);
    await transactionRepository.save(transaction);

    transbankUrl = tbkResponse.url;
    transbankToken = tbkResponse.token;
  } catch (err) {
    transaction.markAsFailed();
    await transactionRepository.save(transaction);
    await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "MARKED_FAILED", { reason: String(err) } as Prisma.InputJsonValue);
    throw new Error("Error initiating payment. Try again later.");
  }

  // Return redirect data for POST form submission to Transbank.
  // NOTE: Next.js Server Actions only support GET redirects via redirect().
  // Transbank docs specify POST with token_ws in body. The client component
  // renders an auto-submitting form to comply with the POST requirement.
  // See: https://transbankdevelopers.cl/documentacion/webpay-plus
  return { url: transbankUrl!, token: transbankToken! };
}

// ─── Use Case 2: Confirm Transaction ──────────────────────────────────────

/**
 * Confirms (commits) the transaction when the user returns from the bank.
 *
 * Scenarios handled:
 * A) Normal flow → commit → save authorized or rejected result
 * B) 422 (double click / page reload) → fallback to getTransactionStatus → recover without FAILED
 * C) Already in terminal state → idempotent, returns current state without calling Transbank
 */
export async function confirmTransactionAction(token: string) {
  const transaction = await transactionRepository.findByToken(token);
  if (!transaction) {
    throw new Error("Transaction not found for the provided token.");
  }

  // Idempotency: terminal state means it was already processed
  if (transaction.isTerminal) {
    return transaction.props;
  }

  // Token expiration: if Transbank token expired (> 5 min), don't attempt commit.
  // Transbank would return an error anyway, but we mark FAILED with observability
  // instead of making an unnecessary network call.
  if (transaction.isTokenExpired) {
    logger.warn(
      { token, buyOrder: transaction.props.buyOrder, createdAt: transaction.props.createdAt },
      "[Webpay] Token expired (>5min), marking as FAILED without calling Transbank",
    );
    transaction.markAsFailed();
    await transactionRepository.save(transaction);
    await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "MARKED_FAILED", {
      reason: "token_expired",
    } as Prisma.InputJsonValue);
    return transaction.props;
  }

  try {
    const response = await getGateway().commitTransaction(token);

    if (response.status === "AUTHORIZED" && response.response_code === 0) {
      transaction.markAsAuthorized({
        authorizationCode: response.authorization_code,
        paymentTypeCode: response.payment_type_code,
        installmentsNumber: response.installments_number,
        installmentsAmount: response.installments_amount ?? undefined,
        responseCode: response.response_code,
        // Audit trail — Transbank data for reconciliation
        vci: response.vci ?? undefined,
        cardNumber: response.card_detail?.card_number && response.card_detail.card_number.length >= 4 ? response.card_detail.card_number.slice(-4) : undefined,
        accountingDate: response.accounting_date ?? undefined,
        transactionDate: response.transaction_date,
      });
    } else {
      transaction.markAsRejected(response.response_code);
    }
  } catch (error) {
    if (error instanceof TransbankAlreadyProcessedError) {
      // User reloaded the success page or there was a double submit.
      // 422 does NOT mean FAILED — it means "already processed before".
      // We query the real status to recover what happened.
      try {
        const status = await getGateway().getTransactionStatus(token);

        if (status.status === "AUTHORIZED" && status.response_code === 0) {
          transaction.markAsAuthorized({
            authorizationCode: status.authorization_code,
            paymentTypeCode: status.payment_type_code,
            installmentsNumber: status.installments_number,
            installmentsAmount: status.installments_amount ?? undefined,
            responseCode: status.response_code,
            // Audit trail — Transbank data for reconciliation
            vci: status.vci ?? undefined,
            cardNumber: status.card_detail?.card_number && status.card_detail.card_number.length >= 4 ? status.card_detail.card_number.slice(-4) : undefined,
            accountingDate: status.accounting_date ?? undefined,
            transactionDate: status.transaction_date,
          });
        } else {
          transaction.markAsRejected(status.response_code);
        }
      } catch (statusError) {
        // getTransactionStatus also failed — mark as FAILED with observability
        logger.error({ err: statusError, token }, "[Webpay] Fallback getTransactionStatus failed after 422");
        transaction.markAsFailed();
      }
    } else {
      // Real technical error: network, timeout, misconfiguration
      transaction.markAsFailed();
    }
  }

  await transactionRepository.save(transaction);

  // Audit log after state transition
  const newStatus = transaction.props.status;
  if (newStatus === "AUTHORIZED") {
    await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "AUTHORIZED", {
      authorizationCode: transaction.props.authCode,
      responseCode: transaction.props.responseCode,
    } as Prisma.InputJsonValue);
  } else if (newStatus === "REJECTED") {
    await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "REJECTED", {
      responseCode: transaction.props.responseCode,
    } as Prisma.InputJsonValue);
  } else if (newStatus === "FAILED") {
    await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "MARKED_FAILED");
  }

  return transaction.props;
}

// ─── Use Case 3: Abort via TBK_TOKEN ──────────────────────────────────────

/**
 * Handles when the user clicks "Abort" on the Transbank gateway.
 *
 * Transbank sends TBK_TOKEN + TBK_ORDEN_COMPRA + TBK_ID_SESION.
 * We use buyOrder to find the transaction in our DB
 * (TBK_TOKEN is not the payment token, it's an abandonment identifier).
 */
export async function abortTransactionAction(tbkToken: string, buyOrder?: string): Promise<void> {
  // Transbank sends buyOrder for both cancellations and timeouts.
  // We find and mark ABORTED immediately to not depend on the Worker.
  // If we don't find the transaction, we log for traceability — not a fatal error.
  if (!buyOrder) {
    logger.warn({ tbkToken }, "[Webpay] abortTransactionAction: buyOrder not provided by Transbank");
    return;
  }
  const transaction = await transactionRepository.findByBuyOrder(buyOrder);

  if (!transaction) {
    logger.warn({ buyOrder, tbkToken }, "[Webpay] abortTransactionAction: buyOrder not found");
    return;
  }

  // Only valid transitions from INITIALIZED — if already in terminal state, don't touch anything.
  if (transaction.isTerminal) return;

  transaction.markAsAbortedByClient(`TBK_TOKEN:${tbkToken.slice(0, 20)}`);
  await transactionRepository.save(transaction);
  await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "ABORTED", { tbkToken: tbkToken.slice(0, 20) } as Prisma.InputJsonValue);
}

// ─── Use Case 4: Worker Polling ─────────────────────────────────────────
// Resolves INITIALIZED transactions that didn't complete the payment flow
// (e.g., user paid but lost connection before the return URL).

/**
 * Exclusive to Worker/Cron. Runs every 5 minutes from the protected
 * /api/webpay/poll endpoint.
 *
 * Finds INITIALIZED transactions older than 10 minutes and queries
 * Transbank for their real status. This handles the case where the user
 * paid but lost connection before reaching the return URL.
 */
export async function pollStaleTransactionsAction(): Promise<{
  processed: number;
  authorized: number;
  rejected: number;
  failed: number;
}> {
  const stale = await transactionRepository.findStaleInitialized(10);

  let authorized = 0;
  let rejected = 0;
  let failed = 0;

  for (const transaction of stale) {
    const token = transaction.props.token;

    if (!token) {
      // No token means never redirected to bank → technical error during creation
      transaction.markAsFailed();
      await transactionRepository.save(transaction);
      await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "MARKED_FAILED", { reason: "no_token" } as Prisma.InputJsonValue);
      failed++;
      continue;
    }

    try {
      const status = await getGateway().getTransactionStatus(token);

      // Race condition guard: re-read from DB after Transbank call.
      // The return handler may have already processed this transaction
      // while we were waiting for Transbank's response.
      const fresh = await transactionRepository.findByToken(token);
      if (fresh?.isTerminal) {
        // Already processed by return handler — skip silently
        continue;
      }

      if (status.status === "AUTHORIZED" && status.response_code === 0) {
        transaction.markAsAuthorized({
          authorizationCode: status.authorization_code,
          paymentTypeCode: status.payment_type_code,
          installmentsNumber: status.installments_number,
          installmentsAmount: status.installments_amount ?? undefined,
          responseCode: status.response_code,
          // Audit trail — Transbank data for reconciliation
          vci: status.vci ?? undefined,
          cardNumber: status.card_detail?.card_number && status.card_detail.card_number.length >= 4 ? status.card_detail.card_number.slice(-4) : undefined,
          accountingDate: status.accounting_date ?? undefined,
          transactionDate: status.transaction_date,
        });
        await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "AUTHORIZED", {
          authorizationCode: status.authorization_code,
          responseCode: status.response_code,
        } as Prisma.InputJsonValue);
        authorized++;
      } else if (status.response_code !== undefined) {
        transaction.markAsRejected(status.response_code);
        await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "REJECTED", {
          responseCode: status.response_code,
        } as Prisma.InputJsonValue);
        rejected++;
      } else {
        // Ambiguous state — leave for next cycle
        continue;
      }

      // Mark as polled AFTER successful Transbank response
      transaction.markAsPolled();

      // Race condition guard #2: re-read BEFORE save to detect if return handler
      // processed this transaction while we were waiting for Transbank's response.
      const freshBeforeSave = await transactionRepository.findByToken(token);
      if (freshBeforeSave?.isTerminal) {
        // Return handler already processed — skip save to avoid overwrite
        continue;
      }

      await transactionRepository.save(transaction);
    } catch {
      // Transbank couldn't respond — is it older than 7 days? → will never resolve
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const referenceDate = transaction.props.transactionDate ?? transaction.props.createdAt;
      if (referenceDate < sevenDaysAgo) {
        transaction.markAsFailed();
        await transactionRepository.save(transaction);
        await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "MARKED_FAILED", { reason: "stale_7d" } as Prisma.InputJsonValue);
        failed++;
      }
      // Otherwise, leave for next cron cycle — polledAt is NOT modified
    }
  }

  return { processed: stale.length, authorized, rejected, failed };
}

// ─── Use Case 5: Refund Transaction ─────────────────────────────────────

/**
 * Refunds (reverses) an already authorized transaction.
 *
 * When is this used?
 * - When the backend fails AFTER Transbank authorized the charge.
 * - When the user requests a refund.
 *
 * Flow (do NOT change this order):
 * 1. Find transaction in DB
 * 2. Domain guard: only AUTHORIZED can be reversed
 * 3. Idempotency: if already REVERSED or terminal, return without calling Transbank
 * 4. Persist current state BEFORE calling Transbank (checkpoint)
 * 5. Call Transbank → refund
 * 6. On success: mark REVERSED, save, audit log
 * 7. On 422 (already processed): fallback to getTransactionStatus, apply real status
 * 8. On timeout/error: do NOT mark REVERSED — leave for manual intervention
 *
 * Who refunds the money?
 * We INSTRUCT Transbank to refund. Transbank takes the amount from
 * our merchant account and returns it to the cardholder. If we don't call
 * this endpoint, the money stays charged.
 *
 * Financial risk: if we double-refund, Transbank charges us twice.
 * That's why the idempotency guard and 422 handling are critical.
 */
export async function refundTransactionAction(
  token: string,
  amount: number,
): Promise<typeof WebpayTransaction.prototype.props> {
  // 1. Find transaction
  const transaction = await transactionRepository.findByToken(token);
  if (!transaction) {
    throw new Error("Transaction not found for the provided token.");
  }

  // 2. Domain guard: only AUTHORIZED can be reversed
  if (transaction.props.status !== "AUTHORIZED") {
    // 3. Idempotency: if already refunded or terminal, return without calling Transbank
    if (transaction.props.status === "REVERSED" || transaction.props.status === "FAILED") {
      return transaction.props;
    }
    // Other states (INITIALIZED, REJECTED, ABORTED) — refund does not apply
    throw new Error(
      `Only AUTHORIZED transactions can be reversed. Current status: ${transaction.props.status}`,
    );
  }

  try {
    // 4. Call Transbank → refund
    const response = await getGateway().requestRefund(token, amount);

    // 5. Success: mark REVERSED
    await reverseTransaction(transaction, {
      type: response.type,
      authorizationCode: response.authorization_code,
      nullifiedAmount: response.nullified_amount,
      responseCode: response.response_code,
    });
  } catch (error) {
    if (error instanceof TransbankRefundAlreadyProcessedError) {
      // 422 = refund already processed (double click, retry, etc.)
      // We query the real status to recover what happened.
      try {
        const status = await getGateway().getTransactionStatus(token);

        if (status.status === "REVERSED" || status.status === "NULLIFIED") {
          // Refund already processed — mark REVERSED in our DB
          await reverseTransaction(transaction, {
            fallback: true,
            transbankStatus: status.status,
            responseCode: status.response_code,
          });
        }
        // If status is still AUTHORIZED: ambiguous state — don't mark REVERSED
        // (refund may have been processed but status hasn't updated yet)
        // Leave for manual intervention or next reconciliation cycle.
      } catch (statusError) {
        // getTransactionStatus also failed — log but don't break
        logger.error(
          { err: statusError, token },
          "[Webpay] Fallback getTransactionStatus failed after refund 422",
        );
      }
    } else if (error instanceof DOMException && error.name === "AbortError") {
      // Timeout: do NOT mark REVERSED — we don't know if Transbank processed the refund.
      // Leave for manual intervention or reconciliation.
      logger.warn(
        { token, amount },
        "[Webpay] Refund timeout — transaction stays AUTHORIZED for manual intervention",
      );
    } else {
      // Real technical error (network, configuration): do NOT mark REVERSED
      logger.error(
        { err: error, token, amount },
        "[Webpay] Refund failed — transaction stays AUTHORIZED",
      );
    }
  }

  return transaction.props;
}
