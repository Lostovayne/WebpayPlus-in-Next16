import { refundTransactionAction } from "@/features/webpay/application/transactionActions";
import logger from "@/shared/lib/logger";
import { getClientIp, rateLimitOrProceed } from "@/shared/rate-limit";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const session = await (async () => {
    try {
      const { auth } = await import("@/features/auth/auth");
      const h = await headers();
      return await auth.api.getSession({ headers: h });
    } catch {
      return null;
    }
  })();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientIp = getClientIp(req);
  return rateLimitOrProceed(req, `refund:${clientIp}`, "1 m", 10, async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid Request", message: "Request body must be valid JSON." },
        { status: 400 },
      );
    }

    const { token, amount } = (body as Record<string, unknown>) ?? {};

    if (typeof token !== "string" || !token) {
      return NextResponse.json(
        { error: "Invalid Request", message: "token is required." },
        { status: 400 },
      );
    }
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid Request", message: "A valid positive integer amount is required." },
        { status: 400 },
      );
    }

    try {
      const result = await refundTransactionAction(token, amount);
      return NextResponse.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error({ err, token }, "[Webpay] Refund failed");
      if (message.includes("not found")) {
        return NextResponse.json({ error: "Not Found", message }, { status: 404 });
      }
      if (message.includes("Only AUTHORIZED")) {
        return NextResponse.json({ error: "Conflict", message }, { status: 409 });
      }
      if (message.includes("Invalid refund amount")) {
        return NextResponse.json({ error: "Invalid Request", message }, { status: 400 });
      }
      return NextResponse.json({ error: "Refund failed", message }, { status: 500 });
    }
  });
}
