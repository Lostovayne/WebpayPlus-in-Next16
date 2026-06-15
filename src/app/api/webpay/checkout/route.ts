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
    // Parse amount from request body
    const body = await req.json().catch(() => null);
    const amount = body?.amount;

    if (typeof amount !== "number" || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid Request", message: "A valid positive amount is required." },
        { status: 400 },
      );
    }

    // Delegate to the existing server action.
    // initiateTransactionAction calls redirect() internally — this is fine
    // in a Route Handler because Next.js intercepts the redirect.
    await initiateTransactionAction(amount);

    // unreachable — redirect() throws before reaching here
    return new NextResponse(null, { status: 303 });
  });
}
