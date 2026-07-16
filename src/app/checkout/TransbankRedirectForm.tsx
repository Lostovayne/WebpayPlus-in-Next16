"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { TransbankRedirectData } from "@/features/webpay/application/transactionActions";

/**
 * Client component that handles POST redirect to Transbank.
 *
 * Why this exists:
 * - Transbank docs require POST with token_ws in the form body
 * - Next.js Server Actions only support GET redirects via redirect()
 * - This component renders a hidden form and auto-submits it via POST
 *   when the server action returns the redirect data.
 *
 * Flow:
 * 1. User clicks "Pay" button
 * 2. Server action creates transaction → returns { url, token }
 * 3. useFormState captures the result
 * 4. useEffect detects the result and populates hidden form fields
 * 5. Form auto-submits via POST to Transbank URL
 *
 * Reference: https://transbankdevelopers.cl/documentacion/webpay-plus
 */
function formatCLP(amount: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    minimumFractionDigits: 0,
  }).format(amount);
}

export function TransbankRedirectForm({
  action,
  amount,
}: {
  action: (formData: FormData) => Promise<TransbankRedirectData>;
  amount: number;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useFormState(
    async (_prev: TransbankRedirectData | null, formData: FormData) => {
      return action(formData);
    },
    null,
  );

  // When server action returns redirect data, auto-submit the POST form
  useEffect(() => {
    if (state?.url && state?.token && formRef.current) {
      formRef.current.submit();
    }
  }, [state]);

  return (
    <>
      {/* Main form — triggers server action */}
      <form action={formAction}>
        <input type="hidden" name="amount" value={amount} />
        <SubmitButton amount={amount} />
      </form>

      {/* Hidden form — auto-submits POST to Transbank */}
      {state?.url && state?.token && (
        <form ref={formRef} method="POST" action={state.url} className="hidden">
          <input type="hidden" name="token_ws" value={state.token} />
        </form>
      )}
    </>
  );
}

function SubmitButton({ amount }: { amount: number }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="group w-full relative overflow-hidden rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-[0.98] transition-all duration-150 px-5 py-4 font-semibold text-white shadow-lg shadow-indigo-900/40 cursor-pointer disabled:opacity-60 disabled:cursor-wait"
    >
      {/* Shimmer effect */}
      <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/10 to-transparent" />

      <span className="relative flex items-center justify-center gap-3">
        {/* Lock icon */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="opacity-80"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span className="text-base">
          {pending ? "Procesando..." : `Pagar ${formatCLP(amount)} con Webpay`}
        </span>
      </span>
    </button>
  );
}
