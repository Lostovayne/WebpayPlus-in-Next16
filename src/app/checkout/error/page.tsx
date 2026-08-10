export default async function CheckoutErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason: rawReason } = await searchParams;
  const ALLOWED_REASONS = new Set([
    "aborted_by_user",
    "timeout",
    "invalid_payload",
    "no_token",
    "no_buy_order",
    "not_authorized",
    "system_failed",
    "REJECTED",
    "FAILED",
    "ABORTED",
  ]);
  const safeReason =
    rawReason && ALLOWED_REASONS.has(rawReason) ? rawReason : "Desconocida";

  return (
    <main className="min-h-screen grid items-center justify-center p-8 bg-black text-white">
      <div className="max-w-md w-full border border-red-800 p-8 rounded-xl bg-gray-900 shadow-2xl text-center">
        <div className="w-16 h-16 bg-red-900 text-red-400 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl font-bold">
          ✕
        </div>
        <h1 className="text-2xl font-bold mb-2 text-red-400">Pago Fallido</h1>
        <p className="text-gray-400 mb-6 font-mono text-sm tracking-widest bg-black/50 p-2 rounded">
          RAZÓN: {safeReason}
        </p>
        <a
          href="/checkout"
          className="text-blue-400 hover:text-blue-300 underline underline-offset-4 text-sm uppercase tracking-wide transition-colors"
        >
          Reintentar o usar otra tarjeta
        </a>
      </div>
    </main>
  );
}
