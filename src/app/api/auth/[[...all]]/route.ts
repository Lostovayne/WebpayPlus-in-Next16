import { auth } from "@/features/auth/auth";
import { NextRequest } from "next/server";

/**
 * BetterAuth API route handler.
 *
 * This catch-all route handles all authentication-related requests:
 * - POST /api/auth/sign-up/email - Register new user
 * - POST /api/auth/sign-in/email - Sign in with email/password
 * - POST /api/auth/sign-out - Sign out
 * - POST /api/auth/two-factor/* - 2FA operations
 * - GET /api/auth/session - Get current session
 * - And all other BetterAuth endpoints
 */
export async function POST(req: NextRequest) {
  return auth.handler(req);
}

export async function GET(req: NextRequest) {
  return auth.handler(req);
}
