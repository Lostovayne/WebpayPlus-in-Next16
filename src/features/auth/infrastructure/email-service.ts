import { Resend } from "resend";
import { env } from "@/shared/env";
import logger from "@/shared/lib/logger";

// Only initialize Resend if API key is configured (optional in dev)
const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

const FROM_EMAIL = env.RESEND_FROM_EMAIL ?? "noreply@localhost";

// ─── Email Templates ────────────────────────────────────────────────────────

function verificationEmailTemplate(url: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a1a;">Verify your email</h2>
  <p style="color: #4a4a4a; line-height: 1.6;">
    Click the button below to verify your email address and activate your account.
  </p>
  <a href="${url}" style="display: inline-block; background: #0070f3; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; margin: 16px 0;">
    Verify Email
  </a>
  <p style="color: #888; font-size: 13px;">
    If you didn't create an account, you can safely ignore this email.
  </p>
  <p style="color: #888; font-size: 13px;">
    This link expires in 24 hours.
  </p>
</body>
</html>`;
}

function otpEmailTemplate(otp: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a1a;">Your verification code</h2>
  <p style="color: #4a4a4a; line-height: 1.6;">
    Use the following code to complete your sign-in:
  </p>
  <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; text-align: center; margin: 16px 0;">
    <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #1a1a1a;">
      ${otp}
    </span>
  </div>
  <p style="color: #888; font-size: 13px;">
    This code expires in 5 minutes. If you didn't request this, someone else may be trying to access your account.
  </p>
</body>
</html>`;
}

function passwordResetTemplate(url: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a1a;">Reset your password</h2>
  <p style="color: #4a4a4a; line-height: 1.6;">
    Click the button below to reset your password. If you didn't request this, you can safely ignore this email.
  </p>
  <a href="${url}" style="display: inline-block; background: #0070f3; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; margin: 16px 0;">
    Reset Password
  </a>
  <p style="color: #888; font-size: 13px;">
    This link expires in 1 hour.
  </p>
</body>
</html>`;
}

// ─── Email Sending Functions ────────────────────────────────────────────────

export async function sendVerificationEmail(
  email: string,
  url: string,
): Promise<void> {
  if (!resend) {
    logger.debug({ email }, "[Auth] Verification email (dev mode, not sent)");
    return;
  }
  await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: "Verify your email address",
    html: verificationEmailTemplate(url),
  });
}

export async function sendOTPEmail(
  email: string,
  otp: string,
): Promise<void> {
  if (!resend) {
    logger.debug({ email }, "[Auth] OTP email (dev mode, not sent)");
    return;
  }
  await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: "Your verification code",
    html: otpEmailTemplate(otp),
  });
}

export async function sendPasswordResetEmail(
  email: string,
  url: string,
): Promise<void> {
  if (!resend) {
    logger.debug({ email }, "[Auth] Password reset email (dev mode, not sent)");
    return;
  }
  await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: "Reset your password",
    html: passwordResetTemplate(url),
  });
}
