<div align="center">

# Webpay Plus — Next.js Integration Reference

![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?style=flat-square&logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![BetterAuth](https://img.shields.io/badge/BetterAuth-1.6-7C3AED?style=flat-square&logo=betterauth&logoColor=white)
![Vercel](https://img.shields.io/badge/Deploy-Vercel-000?style=flat-square&logo=vercel&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)

**Production-grade implementation of Webpay Plus REST API on Next.js 16 App Router.**

No official Transbank SDK. No magic. Just `fetch`, strict types, and architecture that survives production.

[Documentation](https://transbankdevelopers.cl/documentacion/webpay-plus) · [API Reference](https://transbankdevelopers.cl/referencia/webpay#webpay-plus) · [Report a Bug](../../issues)

</div>

---

## Why This Repository?

Most Webpay integrations found online share the same critical flaws:

- They call `commit` without handling **422** → marking transactions as `FAILED` when the user actually paid
- They don't handle Transbank's **5-minute timeout** (GET with `TBK_TOKEN`)
- They don't distinguish **user cancellation** (POST with `TBK_TOKEN`) from the normal flow (POST with `token_ws`)
- They lack **idempotency** → double-click = double charge or corrupted state
- They have no **recovery worker** → if the user pays and loses connection, the transaction stays `INITIALIZED` forever

This repository resolves all of these cases. The implementation is audited against the official API v1.2 reference.

---

## Features

| Feature | Status |
|---|---|
| Webpay Plus REST API v1.2 (no SDK) | ✅ |
| Correct handling of all 3 return URL scenarios | ✅ |
| Idempotent confirmation (safe double-click / reload) | ✅ |
| Smart 422 fallback (already processed → no FAILED) | ✅ |
| Polling worker for abandoned transactions (Vercel Cron) | ✅ |
| Explicit state machine in domain (INITIALIZED → terminal) | ✅ |
| Anti-Corruption Layer (domain doesn't know HTTP) | ✅ |
| Env var validation with Zod 4 at startup (fail-fast) | ✅ |
| Success page verifies real DB state (no query param trust) | ✅ |
| Persist before network call (guaranteed traceability) | ✅ |
| Refund API implemented (`requestRefund`) | ✅ |
| Rate limiting (Upstash + memory fallback) | ✅ |
| BetterAuth (email/password, 2FA, multi-session) | ✅ |
| Email verification + password reset (Resend) | ✅ |
| JWE encrypted session cookies | ✅ |
| Audit logging (databaseHooks) | ✅ |
| Unit tests (76 tests, domain + infrastructure + auth) | ✅ |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5 (strict mode) |
| ORM | Prisma 7 |
| Database | PostgreSQL 17+ |
| Validation | Zod 4 |
| Auth | BetterAuth 1.6 (email/password, 2FA, multi-session) |
| Email | Resend (verification, OTP, password reset) |
| Rate Limiting | Upstash Redis (sliding window) |
| Session Storage | Upstash Redis (secondary storage) |
| Testing | Vitest |
| Package Manager | Bun |
| Deploy | Vercel (Cron Jobs included) |

---

## Architecture

Hexagonal Architecture (Ports & Adapters) organized by feature scope:

```
src/
├── app/                              # Next.js App Router (presentation layer)
│   ├── api/
│   │   ├── auth/[[...all]]/route.ts  # BetterAuth catch-all handler
│   │   └── webpay/
│   │       ├── checkout/route.ts     # POST — initiate payment
│   │       ├── return/route.ts       # POST + GET — Transbank callback
│   │       └── poll/route.ts         # GET — recovery worker (cron)
│   └── checkout/
│       ├── page.tsx                  # Checkout UI
│       ├── success/page.tsx          # Payment confirmation (verifies DB)
│       └── error/page.tsx            # Error screen
│
├── features/
│   ├── auth/                         # Authentication feature module
│   │   ├── auth.ts                   # BetterAuth configuration
│   │   └── infrastructure/
│   │       ├── email-service.ts           # Resend email templates + sending
│   │       ├── upstash-secondary-storage.ts  # Redis adapter for sessions
│   │       └── upstash-secondary-storage.test.ts
│   │
│   ├── webpay/                       # Payment feature module
│   │   ├── domain/
│   │   │   └── Transaction.ts        # Entity + state machine
│   │   ├── application/
│   │   │   └── transactionActions.ts # Use cases (Server Actions)
│   │   └── infrastructure/
│   │       ├── TransbankGateway.ts           # HTTP adapter → Transbank API
│   │       └── PrismaTransactionRepository.ts # DB adapter → Domain
│   │
│   └── rate-limit/                   # Rate limiting feature module
│       ├── domain/
│       │   ├── RateLimitGateway.ts    # Interface (swappable)
│       │   └── parseWindow.ts         # Shared window parser
│       └── infrastructure/
│           ├── UpstashRateLimitGateway.ts   # Upstash adapter
│           └── MemoryRateLimitGateway.ts    # Dev fallback
│
└── shared/
    ├── env.ts                        # Zod-validated env vars
    ├── lib/prisma.ts                 # Prisma client singleton
    └── rate-limit.ts                 # Rate limit factory + helpers
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. INITIATE                                                        │
│    checkout/page.tsx                                               │
│    └── initiateTransactionAction(amount)                            │
│        ├── Create WebpayTransaction (INITIALIZED)                   │
│        ├── Persist to DB ← BEFORE network call                      │
│        ├── TransbankGateway.createTransaction() → token + URL       │
│        ├── Save token to DB                                         │
│        └── redirect() → Transbank payment form                      │
├─────────────────────────────────────────────────────────────────────┤
│ 2. CONFIRM (Transbank callback)                                     │
│    POST /api/webpay/return?token_ws=<token>                         │
│    └── confirmTransactionAction(token)                               │
│        ├── A) Normal: commitTransaction() → AUTHORIZED | REJECTED   │
│        ├── B) 422: getTransactionStatus() → fallback, no FAILED     │
│        └── C) Already terminal: idempotent, return current state    │
├─────────────────────────────────────────────────────────────────────┤
│ 3. RECOVER (Vercel Cron)                                            │
│    GET /api/webpay/poll  [Authorization: Bearer <CRON_SECRET>]      │
│    └── pollStaleTransactionsAction()                                 │
│        └── Find INITIALIZED > 10 min → getTransactionStatus()       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The 3 Return URL Scenarios

This is where 90% of integrations fail. Transbank can call the `return_url` in **three different ways**, and you must handle all of them:

| Scenario | HTTP Method | Parameters |
|---|---|---|
| Payment completed (approved or rejected) | `POST` | `token_ws=<token>` |
| User pressed "Cancel" on the payment page | `POST` | `TBK_TOKEN=<t>` + `TBK_ORDEN_COMPRA=<bo>` + `TBK_ID_SESION=<s>` |
| Timeout (5 min without user action) | `GET` | `TBK_TOKEN=<t>` + `TBK_ORDEN_COMPRA=<bo>` + `TBK_ID_SESION=<s>` |

> [!IMPORTANT]
> When the user *cancels* or there's a *timeout*, **`token_ws` is NOT present**. If you only handle `token_ws`, you're ignoring two of the three scenarios.

---

## Transaction State Machine

```
                    ┌──────────┐
                    │ INITIALIZED │
                    └─────┬────┘
           ┌──────────────┼──────────────┬──────────────┐
           ▼              ▼              ▼              ▼
    ┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ AUTHORIZED  │ │ REJECTED │ │ ABORTED  │ │  FAILED  │
    └──────┬──────┘ └──────────┘ └──────────┘ └──────────┘
           │
           ▼
    ┌──────────┐
    │ REVERSED │
    └──────────┘
```

> [!CAUTION]
> An `AUTHORIZED` transaction **can NEVER revert to `FAILED`**. If Transbank already charged and your system fails afterward, you must call `requestRefund()`. A state rollback is an accounting disaster and a violation of Transbank policies.

---

## Testing

### Test Suite

| Module | Tests | Description |
|---|---|---|
| `Transaction.test.ts` | 24 | Domain state machine (all transitions) |
| `transactionActions.test.ts` | 17 | Application use cases (initiate, confirm, poll) |
| `route.test.ts` | 12 | API route handlers (return callback) |
| `upstash-secondary-storage.test.ts` | 14 | Redis adapter (get/set/delete/increment) |
| **Total** | **76** | |

### Running Tests

```bash
# Run all tests
bun run test

# Run with coverage
bunx vitest run --coverage

# Run specific test file
bunx vitest run src/features/webpay/domain/Transaction.test.ts
```

### Test Architecture

- **Unit tests**: Domain entities, state machine, use cases — no external dependencies
- **Infrastructure tests**: Upstash adapter with mocked `fetch()` — no real Redis needed
- **Integration tests**: API route handlers with mocked gateways — no real Transbank/DB needed

### Future: Integration Tests with Docker (PR7)

Planned: Docker-based PostgreSQL for integration tests against a real database.

```bash
# Will be available in PR7:
bun run test:unit          # Unit tests only (no Docker)
bun run test:integration   # Integration tests (needs Docker)
bun run test:all           # Both
```

---

## Security

### Authentication (BetterAuth)

| Feature | Configuration |
|---|---|
| Email/password auth | Enabled |
| Email verification | Required before first login |
| Two-factor auth (2FA) | TOTP + OTP via email |
| Multi-session | Allowed (multiple devices) |
| Session expiry | 7 days |
| Session refresh | Every 24 hours |
| Fresh age (re-auth) | 30 minutes for sensitive actions |
| Cookie cache | JWE encrypted (prevents tampering) |
| CSRF protection | Enabled (sameSite: strict) |
| Rate limiting | 5 attempts/min for sign-in, 3/min for sign-up |

### Email Service (Resend)

| Email Type | Trigger | Template |
|---|---|---|
| Verification | On sign-up | HTML button → verify link |
| OTP (2FA) | On login with 2FA | 6-digit code, 5 min expiry |
| Password reset | On reset request | HTML button → reset link, 1 hour expiry |

### Audit Logging

Session events are logged via `databaseHooks`:

```json
{"event":"session.create","userId":"...","ipAddress":"...","timestamp":"..."}
{"event":"session.delete","sessionId":"...","userId":"...","timestamp":"..."}
{"event":"user.update","userId":"...","timestamp":"..."}
```

Currently: `console.debug` (JSON structured) — captured by Vercel logs.
Future: Datadog integration for production monitoring.

### Environment Variables Security

- All secrets validated at startup with Zod (fail-fast)
- `BETTER_AUTH_URL`: no default in production (throws if missing)
- `RESEND_API_KEY`/`RESEND_FROM_EMAIL`: optional in dev, required in production
- Upstash: optional in dev (memory fallback), required in production (persistent rate limiting)

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) 1.x (or [Node.js](https://nodejs.org) 20+)
- PostgreSQL 14+ (local or cloud — [Neon](https://neon.tech) recommended)
- Active account on [Transbank Developers Portal](https://www.transbankdevelopers.cl)

### 1. Clone and install

```bash
git clone https://github.com/Lostovayne/Next16_WebpayPlus_Better-Auth.git
cd Next16_WebpayPlus_Better-Auth
bun install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values. See `.env.example` for full documentation of each variable.

### 3. Set up the database

```bash
bunx prisma migrate dev --name init
bunx prisma generate   # (optional — auto-generated if not present)
```

### 4. Start the dev server

```bash
bun dev
```

Open [http://localhost:3000/checkout](http://localhost:3000/checkout).

---

## Test Credentials

These are public, official Transbank integration credentials:

| Variable | Value |
|---|---|
| `WEBPAY_COMMERCE_CODE` | `597055555532` |
| `WEBPAY_API_SECRET` | `579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C` |

**Test cards on the Transbank form:**

| Type | Number | Result |
|---|---|---|
| VISA approved | `4051 8856 0044 6623` | Approved |
| VISA rejected | `4197 0230 0000 0185` | Rejected |
| Mastercard approved | `5186 0595 5959 0568` | Approved |

CVV: any 3-digit number. Expiry: any future date. RUT: `11111111-1`. Password: `123`.

---

## Environment Variables Reference

### Transbank

| Variable | Required | Default (dev) | Description |
|---|---|---|---|
| `WEBPAY_COMMERCE_CODE` | ✅ | `597055555532` | Commerce code from Transbank |
| `WEBPAY_API_SECRET` | ✅ | Integration key | API secret key |
| `WEBPAY_ENVIRONMENT` | ✅ | `integration` | `integration` or `production` |

### Database

| Variable | Required | Default (dev) | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Full PostgreSQL connection string |

### Application

| Variable | Required | Default (dev) | Description |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | ✅ | `http://localhost:3000` | App base URL (no trailing slash) |
| `CRON_SECRET` | ✅ | — | Secret ≥ 32 chars for `/api/webpay/poll` |

### Upstash (Rate Limiting + Sessions)

| Variable | Required | Default (dev) | Description |
|---|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Optional | — | Upstash Redis URL |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | — | Upstash Redis token |

### BetterAuth

| Variable | Required | Default (dev) | Description |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | ✅ | — | Encryption secret (≥ 32 chars) |
| `BETTER_AUTH_URL` | ✅ (prod) | `http://localhost:3000` | Base URL for auth endpoints |

### Resend (Email Service)

| Variable | Required | Default (dev) | Description |
|---|---|---|---|
| `RESEND_API_KEY` | Optional* | — | API key from resend.com |
| `RESEND_FROM_EMAIL` | Optional* | — | Verified sender email |

> *Optional in development (logs instead of sending). Required in production.

> [!WARNING]
> Before going to production, **change** `WEBPAY_COMMERCE_CODE`, `WEBPAY_API_SECRET`, and set `WEBPAY_ENVIRONMENT=production`. Integration credentials won't work in production.

---

## Database Schema

The `webpay_transactions` table stores the complete lifecycle of each payment attempt:

```sql
CREATE TABLE webpay_transactions (
  id                  VARCHAR(36)     PRIMARY KEY,     -- UUID v7
  buy_order           VARCHAR(26)     UNIQUE NOT NULL, -- max 26 chars (Transbank)
  session_id          VARCHAR(61)     NOT NULL,
  amount              DECIMAL(17, 2)  NOT NULL,
  token               VARCHAR(64)     UNIQUE,          -- null until Transbank returns it
  status              VARCHAR(20)     DEFAULT 'INITIALIZED',

  -- Transbank callback data
  vci                 VARCHAR(10),                     -- verification integrity code
  card_number         VARCHAR(19),                     -- last 4 digits
  accounting_date     VARCHAR(4),
  transaction_date    TIMESTAMP,
  auth_code           VARCHAR(6),
  payment_type_code   VARCHAR(2),
  response_code       INTEGER,
  installments_amount DECIMAL(17, 2),
  installments_number INTEGER,
  aborted_reason      VARCHAR(50),
  polled_at           TIMESTAMP,                       -- last worker audit timestamp

  created_at          TIMESTAMP       DEFAULT NOW(),
  updated_at          TIMESTAMP       -- auto-updated by Prisma
);

CREATE INDEX idx_transactions_status_created_polled
  ON webpay_transactions (status, created_at, polled_at);
```

---

## Polling Worker

The `GET /api/webpay/poll` endpoint resolves the **phantom user scenario**: the user paid at the bank but lost connection (WiFi dropped, phone died, tab closed) before returning to the `return_url`. Without this worker, the transaction would stay `INITIALIZED` forever even though the money was debited.

**How it works:**

1. Vercel Cron calls it every 5 minutes (configured in `vercel.json`)
2. Finds transactions in `INITIALIZED` for more than 10 minutes
3. For each one, calls `GET /transactions/{token}` on Transbank
4. Updates status based on response (`AUTHORIZED`, `REJECTED`, or defers to next cycle)
5. After 7 days, if Transbank doesn't respond, marks as `FAILED` (status API no longer available)

**Manual invocation in development:**

```bash
curl -X GET http://localhost:3000/api/webpay/poll \
  -H "Authorization: Bearer your_cron_secret"
```

---

## Deployment to Vercel

### 1. Set environment variables

In your project dashboard → **Settings → Environment Variables**, add all variables from `.env.example` with production values.

### 2. Ensure Cron Jobs are enabled

The `vercel.json` file configures the cron automatically. Ensure your Vercel plan supports Cron Jobs (Pro or higher).

### 3. Deploy

```bash
vercel --prod
# Or simply push to main with CI/CD configured
git push origin master
```

---

## Available Commands

```bash
bun dev          # Dev server with Turbopack (http://localhost:3000)
bun build        # Production build
bun start        # Production server
bun test         # Run all tests (Vitest)

# Prisma
bunx prisma migrate dev --name <name>   # New migration
bunx prisma generate                     # Regenerate client
bunx prisma studio                       # DB GUI in browser
bunx prisma migrate status               # Migration status
```

---

## Anti-Corruption Layer

`TransbankGateway` is the only file that knows Transbank exists. The domain and application work with clean interfaces:

```typescript
// ✅ The domain only knows this:
interface WebpayInitResponse {
  token: string;
  url: string;
}

// ✅ And the use case only does this:
const { token, url } = await gateway.createTransaction(buyOrder, sessionId, amount, returnUrl);

// ❌ Never this in the domain or application:
fetch("https://webpay3g.transbank.cl/...", { headers: { "Tbk-Api-Key-Id": ... } });
```

If Transbank changes their API, URL, or headers tomorrow, **you only touch `TransbankGateway.ts`** — the rest of the system doesn't know anything happened.

---

## 422 Error Handling

Transbank's 422 deserves special attention. Their documentation states:

> *If the merchant retries the commit of an already-confirmed transaction, they'll receive HTTP 422.*

This happens more often than you'd think: user double-click, page reload, worker retry, network drop after commit. The correct approach is **not** marking `FAILED` — it's querying the real status:

```typescript
try {
  const response = await gateway.commitTransaction(token);
  // Normal flow...
} catch (error) {
  if (error instanceof TransbankAlreadyProcessedError) {
    // 422: already processed → recover real status without marking FAILED
    const status = await gateway.getTransactionStatus(token);
    // Now we update the status correctly
  }
}
```

---

## Transbank API Limitations

| Restriction | Value | Impact |
|---|---|---|
| `buy_order` max | 26 characters | Validated in domain |
| `session_id` max | 61 characters | UUID v4 = 36 chars ✅ |
| Max amount CLP | 999,999,999 | Validated in domain |
| Min amount | > 0 | Validated in domain |
| Status availability (`GET /transactions/{token}`) | 7 days from creation | Worker respects this |
| Refund (`POST /transactions/{token}/refunds`) | Same business day for reversal; nullification has different rules | Don't ignore in production |

---

## Contributing

1. Fork the repository
2. Create a branch: `git checkout -b feat/my-improvement`
3. Commit your changes: `git commit -m "feat: description"`
4. Push: `git push origin feat/my-improvement`
5. Open a Pull Request

Before submitting, ensure tests pass:

```bash
bun test
```

---

## License

MIT — use it, modify it, sell it if you want. Just don't come crying when you didn't handle the 422.

---

<div align="center">

Documentation: [transbankdevelopers.cl](https://transbankdevelopers.cl) · API Reference: [Webpay Plus](https://transbankdevelopers.cl/referencia/webpay#webpay-plus)

</div>
