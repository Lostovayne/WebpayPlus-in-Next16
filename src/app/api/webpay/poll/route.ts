import { pollStaleTransactionsAction } from "@/features/webpay/application/transactionActions";
import logger from "@/shared/lib/logger";
import { env } from "@/shared/env";
import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/webpay/poll — Worker de Polling de Transacciones Abandonadas
 *
 * ¿Por qué existe esto?
 * Con la API REST de Transbank, si el usuario paga en el banco pero pierde
 * conexión antes de llegar al return URL, el dinero queda retenido y
 * nuestra BD queda en INITIALIZED para siempre. Este Worker lo resuelve.
 *
 * ¿Cómo funciona?
 * Vercel Cron Jobs llama a este endpoint cada 5 minutos (configurado en vercel.json).
 * El endpoint verifica el CRON_SECRET, llama al use case de polling,
 * y retorna un resumen de cuántas transacciones procesó.
 *
 * Seguridad:
 * Sin el header `Authorization: Bearer <CRON_SECRET>` correcto → 401.
 * Vercel agrega este header automáticamente cuando usa Cron Jobs.
 * Para testing local puedes llamarlo con: curl -H "Authorization: Bearer <tu_secret>" http://localhost:3000/api/webpay/poll
 */
export async function GET(req: NextRequest) {
  // Verificación de seguridad — solo el Cron Job de Vercel (con el secret) puede llamar esto
  const authHeader = req.headers.get("authorization");
  const expectedAuth = `Bearer ${env.CRON_SECRET}`;

  if (authHeader !== expectedAuth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await pollStaleTransactionsAction();

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    logger.error({ err: error }, "[Worker Poll] Error durante el polling");
    return NextResponse.json({ ok: false, error: "Internal polling error" }, { status: 500 });
  }
}
