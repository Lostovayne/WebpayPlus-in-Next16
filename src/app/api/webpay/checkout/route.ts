import { initiateTransactionAction } from "@/features/webpay/application/transactionActions";
import { NextRequest, NextResponse } from "next/server";
import { getClientIp, rateLimitOrProceed } from "@/shared/rate-limit";

/**
 * POST /api/webpay/checkout
 *
 * Rate-limited checkout endpoint. Creates a Webpay Plus transaction
 * and redirects the user to Transbank's payment form.
 *
 * Rate limit: per-IP sliding window (default 60 req/min).
 * The return route (/api/webpay/return) is NOT rate-limited because
 * Transbank callbacks are server-to-server and must always succeed.
 */
export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const key = `checkout:${clientIp}`;

  return rateLimitOrProceed(req, key, "1 m", 60, async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid Request", message: "Request body must be valid JSON." },
        { status: 400 },
      );
    }

    const amount = (body as Record<string, unknown>)?.amount;

    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid Request", message: "A valid positive integer amount is required." },
        { status: 400 },
      );
    }

    try {
      const result = await initiateTransactionAction(amount);
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.includes("already processed")) {
        return NextResponse.json({ error: "Conflict", message }, { status: 409 });
      }
      if (message.includes("in progress")) {
        return NextResponse.json({ error: "Conflict", message }, { status: 409 });
      }
      if (message.includes("Invalid amount") || message.includes("Invalid idempotency")) {
        return NextResponse.json({ error: "Invalid Request", message }, { status: 400 });
      }
      return NextResponse.json(
        { error: "Payment initiation failed", message },
        { status: 500 },
      );
    }
  });
}
