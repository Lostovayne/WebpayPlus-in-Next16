import {
  EmailMessage,
  EmailProvider,
  EmailResult,
} from "@/features/auth/domain/email-provider";
import {
  otpEmailTemplate,
  passwordResetTemplate,
  verificationEmailTemplate,
} from "@/features/auth/domain/email-templates";
import { ResendEmailProvider } from "./providers/resend-provider";
import { env } from "@/shared/env";
import logger from "@/shared/lib/logger";

// ─── NoopEmailProvider ─────────────────────────────────────────────────────────
// Dev-mode provider: logs the email instead of sending. Used when no Resend
// API key is configured (common in local development).

class NoopEmailProvider implements EmailProvider {
  readonly name = "noop";

  async send(message: EmailMessage): Promise<EmailResult> {
    logger.debug(
      { to: message.to, subject: message.subject },
      "[Auth] Email (dev mode, not sent)",
    );
    return { id: null, provider: "noop" };
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates the appropriate email provider based on environment configuration.
 *
 * - Production/integration: ResendEmailProvider (real email delivery)
 * - Dev mode (no API key): NoopEmailProvider (logs only, no network calls)
 *
 * The provider is selected at call site, not at module load time.
 */
export function createEmailProvider(): EmailProvider {
  if (env.RESEND_API_KEY) {
    return new ResendEmailProvider(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL);
  }
  return new NoopEmailProvider();
}

// ─── Lazy Singleton ────────────────────────────────────────────────────────────

let cachedProvider: EmailProvider | null = null;

/**
 * Returns the email provider, creating it on first call.
 * Subsequent calls return the cached singleton.
 */
export function getEmailProvider(): EmailProvider {
  if (!cachedProvider) {
    cachedProvider = createEmailProvider();
  }
  return cachedProvider;
}

/**
 * Test-only: override or reset the cached email provider.
 * Pass a mock provider to inject it, or `null` to reset to factory default.
 */
export function _setEmailProvider(provider: EmailProvider | null): void {
  cachedProvider = provider;
}

// ─── Retry Helper ──────────────────────────────────────────────────────────────

/**
 * Retry wrapper with exponential backoff for email sending.
 * Transient failures (rate limits, network hiccups) are retried up to 5 times.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        logger.warn({ attempt, delayMs }, "[Auth] Email send failed, retrying...");
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

// ─── Email Sending Functions ───────────────────────────────────────────────────
// Public API — signatures must NOT change for auth.ts compatibility.

export async function sendVerificationEmail(
  email: string,
  url: string,
): Promise<void> {
  const provider = getEmailProvider();
  await withRetry(() =>
    provider.send({
      to: email,
      subject: "Verify your email address",
      html: verificationEmailTemplate(url),
    }),
  );
}

export async function sendOTPEmail(
  email: string,
  otp: string,
): Promise<void> {
  const provider = getEmailProvider();
  await withRetry(() =>
    provider.send({
      to: email,
      subject: "Your verification code",
      html: otpEmailTemplate(otp),
    }),
  );
}

export async function sendPasswordResetEmail(
  email: string,
  url: string,
): Promise<void> {
  const provider = getEmailProvider();
  await withRetry(() =>
    provider.send({
      to: email,
      subject: "Reset your password",
      html: passwordResetTemplate(url),
    }),
  );
}
