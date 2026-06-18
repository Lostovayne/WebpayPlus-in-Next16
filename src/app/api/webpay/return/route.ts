import {
  abortTransactionAction,
  confirmTransactionAction,
} from "@/features/webpay/application/transactionActions";
import logger from "@/shared/lib/logger";
import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/webpay/return
 *
 * Transbank hace POST aquí cuando el usuario termina en la pasarela.
 * El body es application/x-www-form-urlencoded, NO JSON.
 *
 * Hay 2 escenarios posibles en el POST:
 *
 * 1. PAGO COMPLETADO (exitoso o rechazado por el banco):
 *    Body: token_ws=<token>
 *    → Hacer commit y redirigir según resultado.
 *
 * 2. USUARIO CANCELÓ en la pasarela (presionó "Anular"):
 *    Body: TBK_TOKEN=<tbk_token>&TBK_ORDEN_COMPRA=<buy_order>&TBK_ID_SESION=<session>
 *    → Marcar como ABORTED y redirigir a error.
 *    Nota: En este caso NO viene token_ws — es un error común confundirlo.
 */
export async function POST(req: NextRequest) {
  const text = await req.text();
  const params = new URLSearchParams(text);

  const tbkToken = params.get("TBK_TOKEN");
  const buyOrder = params.get("TBK_ORDEN_COMPRA");

  // Escenario 2: Cancelación del usuario
  if (tbkToken) {
    await abortTransactionAction(tbkToken, buyOrder ?? "unknown");
    return NextResponse.redirect(new URL("/checkout/error?reason=aborted_by_user", req.url), 303);
  }

  // Escenario 1: Flujo normal (pago completado o rechazado por el banco)
  const token = params.get("token_ws");
  if (!token) {
    // Payload vacío o manipulado — no deberíamos llegar aquí en condiciones normales
    logger.error({ payload: text }, "[Webpay POST] Payload sin token_ws ni TBK_TOKEN");
    return NextResponse.redirect(new URL("/checkout/error?reason=invalid_payload", req.url), 303);
  }

  try {
    const transaction = await confirmTransactionAction(token);

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
    logger.error({ err: error }, "[Webpay POST] Error en confirmación");
    return NextResponse.redirect(new URL("/checkout/error?reason=system_failed", req.url), 303);
  }
}

/**
 * GET /api/webpay/return
 *
 * Transbank usa GET en 2 escenarios:
 *
 * 1. TIMEOUT (5 minutos sin que el usuario pagara):
 *    Query: ?TBK_TOKEN=xxx&TBK_ORDEN_COMPRA=yyy&TBK_ID_SESION=zzz
 *    → El usuario tardó demasiado. La sesión de pago expiró.
 *
 * 2. USUARIO RECARGÓ la página de retorno después de un pago exitoso:
 *    Query: ?token_ws=xxx
 *    → El use case maneja esto con idempotencia (ya está en estado terminal).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const tbkToken = searchParams.get("TBK_TOKEN");
  const buyOrder = searchParams.get("TBK_ORDEN_COMPRA");

  // Escenario 1: Timeout — el usuario no pagó a tiempo
  if (tbkToken) {
    await abortTransactionAction(tbkToken, buyOrder ?? "unknown");
    return NextResponse.redirect(new URL("/checkout/error?reason=timeout", req.url), 303);
  }

  // Escenario 2: Recarga de página de éxito (o flujo directo)
  const token = searchParams.get("token_ws");
  if (!token) {
    return NextResponse.redirect(new URL("/checkout/error?reason=no_token", req.url), 303);
  }

  try {
    const transaction = await confirmTransactionAction(token);

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
    logger.error({ err: error }, "[Webpay GET] Error en confirmación");
    return NextResponse.redirect(new URL("/checkout/error?reason=system_failed", req.url), 303);
  }
}
