# AGENTS.md — Webpay Plus Project Rules

## Architecture

- **Hexagonal Architecture**: domain → application → infrastructure
- Domain layer knows NOTHING about Prisma, HTTP, or external services
- Infrastructure adapters translate between domain and external world
- Application layer (use cases) orchestrates domain + infrastructure

## File Organization

```
src/
  features/
    {feature}/
      domain/          ← Entities, value objects, state machines
      application/     ← Use cases, server actions ("use server")
      infrastructure/  ← Adapters: DB repos, external API gateways
      __mocks__/       ← Test mocks (when needed)
  shared/
    env.ts             ← Zod-validated environment variables
    lib/               ← Shared singletons (prisma, logger)
    rate-limit.ts      ← Rate limit helper
  app/                 ← Next.js App Router (routes, pages, layouts)
    api/               ← API route handlers
```

## Conventions

- **Language**: English for all code, comments, types, and UI strings. Spanish only in user-facing chat.
- **Commits**: Conventional commits (feat/fix/chore/test/docs). No "Co-Authored-By" or AI attribution.
- **Naming**: camelCase for variables/functions, PascalCase for classes/types, UPPER_SNAKE for constants.
- **Path aliases**: `@/` → `src/`, `generated/` → `generated/prisma/`

## Transbank Webpay Plus API (CRITICAL)

Source: https://www.transbankdevelopers.cl/referencia/webpay

### Authentication

All requests require two headers:
- `Tbk-Api-Key-Id`: Commerce code
- `Tbk-Api-Key-Secret`: Secret key
- `Content-Type: application/json`

### Endpoints

| Operation | Method | Path |
|-----------|--------|------|
| Create transaction | POST | `/rswebpaytransaction/api/webpay/v1.2/transactions` |
| Commit transaction | PUT | `/rswebpaytransaction/api/webpay/v1.2/transactions/{token}` |
| Refund | POST | `/rswebpaytransaction/api/webpay/v1.2/transactions/{token}/refunds` |
| Get status | GET | `/rswebpaytransaction/api/webpay/v1.2/transactions/{token}` |

### Environments

- **Integration**: `https://webpay3gint.transbank.cl`
- **Production**: `https://webpay3g.transbank.cl`

### Transaction Flow

1. `create()` → returns `{ token, url }` — redirect user to `url`
2. User pays on Transbank's hosted form
3. Transbank redirects to `return_url` with `token_ws`
4. `commit(token)` → returns full transaction status
5. Optionally `refund(token, amount)` to reverse

### Transaction Statuses

- `INITIALIZED` — created, user hasn't paid yet
- `AUTHORIZED` — payment approved (final)
- `REVERSED` — refunded by merchant (final)
- `FAILED` — payment failed (final)
- `NULLIFIED` — voided (partial or full)
- `PARTIALLY_NULLIFIED` — partial void
- `CAPTURED` — settled

### Response Codes

- `0` = Approved
- `-1` = Rejected by issuer
- `-2` = Issuer not available
- `-3` = Rejected by issuer (no retry)
- `-4` = Rejected by issuer
- `-5` = Rejected by issuer
- `-6` = Exceeded attempts
- `-7` = Card blocked
- `-8` = Card expired
- `-9` = Insufficient funds
- `-10` = Restricted card
- Other negative codes = rejection

### Refund Types

- `REVERSED` — refund not yet processed by Transbank (only type returned)
- `NULLIFIED` — refund processed, includes authorization_code, balance, etc.

### Error Codes (Refund)

- `304` — Null input validation
- `245` — Commerce code doesn't exist
- `22` — Commerce inactive
- `316` — Commerce mismatch
- `308` — Operation not allowed
- `274` — Transaction not found
- `16` — Transaction doesn't allow refund
- `292` — Transaction not authorized
- `284` — Refund period exceeded
- `310` — Already refunded
- `311` — Amount exceeds available balance
- `312` — Generic refund error

### Buy Order Rules

- Max 26 characters
- Alphanumeric + `|_=&%.,~:/?[+!@()>-`
- No accents or special characters
- Must be unique per transaction

### Amount Rules

- Max 17 digits
- Integer for CLP (Chilean pesos)
- 2 decimal places for USD

## Payment Flow Rules (CRITICAL)

1. **Persist BEFORE network**: Always save transaction to DB before calling Transbank. If the call fails, you still have a FAILED record.
2. **Domain state machine**: Only `WebpayTransaction` transition methods can change status. Never mutate `status` directly.
3. **Idempotency**: `buyOrder` is unique. Parallel requests with same key must handle `P2002` race condition.
4. **Audit trail**: Every state transition goes to `transaction_audit_log`. Audit failures must NOT break the transaction flow.
5. **422 ≠ FAILED**: Transbank 422 means "already processed" — fall back to `getTransactionStatus`, don't mark FAILED.
6. **Refund only AUTHORIZED**: Only AUTHORIZED transactions can be refunded. Other states throw.
7. **Refund idempotency**: If already REVERSED or FAILED, return silently without calling Transbank.

## Testing Rules

- **Strict TDD**: RED → GREEN → REFACTOR. Tests first.
- **Test location**: Co-located with source (`*.test.ts` next to `*.ts`)
- **Mocking**: Mock at infrastructure boundary (TransbankGateway, PrismaRepository). Domain tests use real entities.
- **Coverage**: Target 80%+. Run `bun run test:run --coverage` to verify.
- **Test command**: `bun run test:run`

## Security Rules

- **PCI DSS**: Never log full card numbers. Only last 4 digits, max.
- **Env vars**: Validated at startup via Zod. Missing = crash immediately.
- **Rate limiting**: Checkout endpoint rate-limited per IP. Return route is NOT rate-limited (Transbank callback).
- **CSP**: Strict Content-Security-Policy headers. Only Transbank domains allowed in connect-src.
- **Cookies**: JWE encrypted, sameSite: strict, httpOnly, secure.
- **TLS**: All Transbank communication over TLSv1.2+.
- **Credentials**: Never commit commerce codes or API secrets. Use env vars.
- **Monitoring**: Log suspicious activity (unusual countries, excessive consumption).

## Code Review Checklist

- [ ] Domain entity state transitions are valid
- [ ] Persist-before-network pattern followed
- [ ] Audit log written for state changes
- [ ] No full card numbers logged (PCI DSS)
- [ ] Env vars validated (no silent undefined)
- [ ] Tests cover happy path + error paths
- [ ] No `Prisma.InputJsonValue` casts bypassing type safety
- [ ] Rate limiting applied where needed
- [ ] Transbank API compatibility maintained
- [ ] Buy order ≤ 26 chars, no accents
- [ ] Amount is integer for CLP
- [ ] Token in URL, not body (commit/refund)
