import {
  abortTransactionAction,
  confirmTransactionAction,
} from "@/features/webpay/application/transactionActions";
import logger from "@/shared/lib/logger";
import { NextRequest, NextResponse } from "next/server";

type ReturnParams = {
  tokenWs: string | null;
  tbkToken: string | null;
  buyOrder: string | null;
};

function parseReturnParams(searchParams: URLSearchParams): ReturnParams {
  return {
    tokenWs: searchParams.get("token_ws"),
    tbkToken: searchParams.get("TBK_TOKEN"),
    buyOrder: searchParams.get("TBK_ORDEN_COMPRA"),
  };
}

/**
 * Transbank return flows (API v1.2):
 * 1. Normal: token_ws only → commit
 * 2. Timeout: TBK_ORDEN_COMPRA + TBK_ID_SESION only (no token)
 * 3. User abort: TBK_TOKEN + TBK_ORDEN_COMPRA + TBK_ID_SESION
 * 4. Error edge case: both token_ws and TBK_TOKEN — treat as abort (TBK_TOKEN wins)
 */
async function handleReturn(
  req: NextRequest,
  params: ReturnParams,
  invalidPayloadReason: string,
): Promise<NextResponse> {
  const { tokenWs, tbkToken, buyOrder } = params;

  if (tbkToken) {
    if (buyOrder) {
      await abortTransactionAction(buyOrder, tbkToken);
    }
    return NextResponse.redirect(
      new URL("/checkout/error?reason=aborted_by_user", req.url),
      303,
    );
  }

  if (buyOrder && !tokenWs) {
    await abortTransactionAction(buyOrder);
    return NextResponse.redirect(
      new URL("/checkout/error?reason=timeout", req.url),
      303,
    );
  }

  if (!tokenWs) {
    return NextResponse.redirect(
      new URL(`/checkout/error?reason=${invalidPayloadReason}`, req.url),
      303,
    );
  }

  try {
    const transaction = await confirmTransactionAction(tokenWs);

    if (transaction.status === "AUTHORIZED") {
      return NextResponse.redirect(
        new URL(`/checkout/success?buyOrder=${transaction.buyOrder}`, req.url),
        303,
      );
    }

    return NextResponse.redirect(
      new URL(`/checkout/error?reason=${transaction.status}`, req.url),
      303,
    );
  } catch (error) {
    logger.error({ err: error }, "[Webpay] Error en confirmación");
    return NextResponse.redirect(
      new URL("/checkout/error?reason=system_failed", req.url),
      303,
    );
  }
}

/**
 * POST /api/webpay/return
 *
 * Transbank POST here when the user finishes on the gateway (integration abort flow).
 * Body is application/x-www-form-urlencoded, NOT JSON.
 */
export async function POST(req: NextRequest) {
  const text = await req.text();
  const params = parseReturnParams(new URLSearchParams(text));

  if (!params.tokenWs && !params.tbkToken && !params.buyOrder) {
    logger.error(
      { payload: text },
      "[Webpay POST] Payload missing token_ws and TBK_TOKEN",
    );
  }

  return handleReturn(req, params, "invalid_payload");
}

/**
 * GET /api/webpay/return
 *
 * Transbank GET here on normal return (API v1.1+) and production abort/timeout flows.
 */
export async function GET(req: NextRequest) {
  return handleReturn(
    req,
    parseReturnParams(req.nextUrl.searchParams),
    "no_token",
  );
}
