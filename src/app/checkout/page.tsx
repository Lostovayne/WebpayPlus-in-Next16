import { initiateTransactionAction } from "@/features/webpay/application/transactionActions";
import { TransbankRedirectForm } from "./TransbankRedirectForm";

// ─── Datos del producto (en un sistema real vendrían de props/params/DB) ─────
const PRODUCT = {
  name: "Plan Pro — Licencia Anual",
  description:
    "Acceso completo a todas las funciones premium, soporte prioritario y actualizaciones ilimitadas durante 12 meses.",
  price: 15000,
  originalPrice: 19990,
  sku: "PRO-ANNUAL-2026",
  features: [
    "Acceso ilimitado a todos los módulos",
    "Soporte 24/7 por chat y correo",
    "Actualizaciones automáticas incluidas",
    "Factura electrónica inmediata",
  ],
};

function formatCLP(amount: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    minimumFractionDigits: 0,
  }).format(amount);
}

const discount = PRODUCT.originalPrice - PRODUCT.price;
const discountPct = Math.round((discount / PRODUCT.originalPrice) * 100);

export const metadata = {
  title: "Checkout — Plan Pro",
  description: "Completa tu compra de forma segura con Webpay Plus.",
};

export default function CheckoutPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">
      {/* ─── Nav bar mínimo ──────────────────────────────────────────────── */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2.5"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <span className="font-semibold tracking-tight text-zinc-100">
              MiTienda
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Pago seguro con SSL
          </div>
        </div>
      </header>

      {/* ─── Contenido principal ─────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 py-10 md:py-16 grid md:grid-cols-[1fr_380px] gap-8 items-start">
        {/* ─── Columna izquierda: Detalle del producto ─────────────────── */}
        <section className="space-y-6">
          {/* Breadcrumb */}
          <nav className="text-xs text-zinc-500 flex items-center gap-1.5">
            <a href="/" className="hover:text-zinc-300 transition-colors">
              Inicio
            </a>
            <span>/</span>
            <a
              href="/productos"
              className="hover:text-zinc-300 transition-colors"
            >
              Planes
            </a>
            <span>/</span>
            <span className="text-zinc-400">Plan Pro</span>
          </nav>

          {/* Card del producto */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 overflow-hidden">
            {/* Banner del producto */}
            <div className="relative bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-950 h-40 flex items-center justify-center overflow-hidden">
              <div
                className="absolute inset-0 opacity-20"
                style={{
                  backgroundImage:
                    "radial-gradient(circle at 30% 50%, #6366f1 0%, transparent 60%), radial-gradient(circle at 70% 30%, #8b5cf6 0%, transparent 50%)",
                }}
              />
              <div className="relative text-center">
                <div className="w-14 h-14 rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center mx-auto mb-2 backdrop-blur-sm">
                  <svg
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="1.5"
                  >
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                </div>
                <div className="inline-flex items-center gap-1.5 bg-indigo-500/30 border border-indigo-400/30 rounded-full px-3 py-1 text-xs font-medium text-indigo-200">
                  ✦ Más popular
                </div>
              </div>
            </div>

            <div className="p-6 space-y-5">
              {/* Título y precio */}
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-mono text-zinc-500 mb-1">
                    SKU: {PRODUCT.sku}
                  </p>
                  <h1 className="text-xl font-semibold text-zinc-100 leading-snug">
                    {PRODUCT.name}
                  </h1>
                  <p className="mt-1.5 text-sm text-zinc-400 leading-relaxed">
                    {PRODUCT.description}
                  </p>
                </div>
              </div>

              {/* Precios */}
              <div className="flex items-end gap-3">
                <span className="text-3xl font-bold text-zinc-100">
                  {formatCLP(PRODUCT.price)}
                </span>
                <div className="pb-1 flex items-center gap-2">
                  <span className="text-sm text-zinc-500 line-through">
                    {formatCLP(PRODUCT.originalPrice)}
                  </span>
                  <span className="bg-emerald-950 text-emerald-400 text-xs font-semibold px-2 py-0.5 rounded-full border border-emerald-900">
                    -{discountPct}%
                  </span>
                </div>
              </div>

              {/* Ahorro */}
              <p className="text-sm text-emerald-400 flex items-center gap-1.5">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                Ahorras {formatCLP(discount)} con esta oferta
              </p>

              {/* Divisor */}
              <div className="border-t border-zinc-800" />

              {/* Features */}
              <ul className="space-y-2.5">
                {PRODUCT.features.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2.5 text-sm text-zinc-300"
                  >
                    <svg
                      className="mt-0.5 shrink-0 text-indigo-400"
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ─── Columna derecha: Resumen y pago ─────────────────────────── */}
        <section className="space-y-4 md:sticky md:top-8">
          {/* Resumen de orden */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              Resumen del pedido
            </h2>

            <div className="space-y-2.5">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Plan Pro × 1</span>
                <span className="text-zinc-300">
                  {formatCLP(PRODUCT.originalPrice)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-emerald-400">Descuento aplicado</span>
                <span className="text-emerald-400">−{formatCLP(discount)}</span>
              </div>
              <div className="border-t border-zinc-800 pt-2.5 flex justify-between">
                <span className="font-semibold text-zinc-200">Total</span>
                <span className="font-bold text-lg text-zinc-100">
                  {formatCLP(PRODUCT.price)}
                </span>
              </div>
            </div>

            {/* Botón de pago — POST redirect a Transbank */}
            <TransbankRedirectForm
              action={async (formData) => {
                "use server";
                const amount = Number(formData.get("amount"));
                return initiateTransactionAction(amount);
              }}
              amount={PRODUCT.price}
            />

            {/* Badge Webpay */}
            <div className="flex items-center justify-center gap-2 pt-1">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#71717a"
                strokeWidth="2"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <span className="text-xs text-zinc-500">
                Pago procesado por{" "}
                <span className="text-zinc-400 font-medium">Webpay Plus</span> ·
                Transbank
              </span>
            </div>
          </div>

          {/* Garantías */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
            {[
              {
                icon: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
                label: "Pago 100% seguro",
                sub: "Encriptación SSL de 256 bits",
              },
              {
                icon: (
                  <>
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </>
                ),
                label: "Factura electrónica",
                sub: "Se envía automáticamente",
              },
              {
                icon: (
                  <>
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </>
                ),
                label: "Acceso inmediato",
                sub: "Actívate en segundos tras el pago",
              },
            ].map(({ icon, label, sub }) => (
              <div key={label} className="flex items-start gap-3">
                <div className="mt-0.5 w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#a1a1aa"
                    strokeWidth="2"
                  >
                    {icon}
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-medium text-zinc-300">{label}</p>
                  <p className="text-xs text-zinc-600">{sub}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
