<div align="center">

# WebpayPlus-in-Next16

### Integración Completa de Pagos con Transbank Webpay Plus en Next.js 16

![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?style=flat-square&logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![BetterAuth](https://img.shields.io/badge/BetterAuth-1.6-7C3AED?style=flat-square&logo=betterauth&logoColor=white)
![Vitest](https://img.shields.io/badge/Tests-99-73DD52?style=flat-square&logo=vitest&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)

**Template profesional para e-commerce chileno con autenticación, rate limiting, logging estructurado, y arquitectura hexagonal.**

[Documentación Transbank](https://transbankdevelopers.cl/documentacion/webpay-plus) · [API Reference](https://transbankdevelopers.cl/referencia/webpay#webpay-plus) · [Reportar Bug](../../issues)

</div>

---

## ¿Qué es este repositorio?

Implementación completa y lista para producción del flujo de pagos **Webpay Plus** de Transbank en **Next.js 16 App Router** con **TypeScript** y **Prisma 7**.

No usa el SDK oficial de Transbank. Solo `fetch`, tipos estrictos, y una arquitectura hexagonal que sobrevive en producción.

### Problemas que resuelve

La mayoría de integraciones Webpay que encuentras en línea tienen los mismos errores críticos:

- Llaman `commit` sin manejar **422** → marcan transacciones como `FAILED` cuando el usuario sí pagó
- No manejan el **timeout de 5 minutos** de Transbank (GET con `TBK_TOKEN`)
- No distinguen **cancelación del usuario** (POST con `TBK_TOKEN`) del flujo normal (POST con `token_ws`)
- No tienen **idempotencia** → doble clic = doble cargo o estado corrupto
- No tienen **worker de recuperación** → si el usuario paga y pierde conexión, la transacción queda `INITIALIZED` para siempre

Este repositorio resuelve todos estos casos. La implementación está auditada contra la referencia oficial de la API v1.2.

---

## Características

| Característica | Estado |
|---|---|
| Webpay Plus REST API v1.2 (sin SDK) | ✅ |
| Manejo correcto de los 3 escenarios de return URL | ✅ |
| Confirmación idempotente (doble clic/reload seguro) | ✅ |
| Fallback inteligente para 422 (ya procesada → sin FAILED) | ✅ |
| Polling worker para transacciones abandonadas (Vercel Cron) | ✅ |
| Máquina de estados explícita en dominio (INITIALIZED → terminal) | ✅ |
| Anti-Corruption Layer (el dominio no conoce HTTP) | ✅ |
| Validación de variables de entorno con Zod 4 al startup | ✅ |
| Página de éxito verifica estado real de la BD | ✅ |
| Persistencia antes de llamada a red (trazabilidad garantizada) | ✅ |
| API de reembolsos (`requestRefund`) | ✅ |
| Rate limiting (Upstash Redis + fallback en memoria) | ✅ |
| BetterAuth (email/password, 2FA, multi-session) | ✅ |
| Verificación de email + reset de contraseña (Resend) | ✅ |
| Sesiones JWE en cookies encriptadas | ✅ |
| Audit logging completo (tabla `transaction_audit_log`) | ✅ |
| Pino structured logging (JSON para Datadog/ELK) | ✅ |
| Idempotencia con P2002 race condition handling | ✅ |
| 99 tests con Vitest (unit + integration) | ✅ |

---

## Stack Tecnológico

| Capa | Tecnología |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Lenguaje | TypeScript 5 (strict mode) |
| ORM | Prisma 7 |
| Base de datos | PostgreSQL 17+ |
| Validación | Zod 4 |
| Autenticación | BetterAuth 1.6 (email/password, 2FA, multi-session) |
| Email | Resend (verificación, OTP, reset de contraseña) |
| Rate Limiting | Upstash Redis (sliding window) |
| Sesiones | Upstash Redis (secondary storage) |
| Logging | Pino (structured JSON) |
| Testing | Vitest (99 tests) |
| Package Manager | Bun |
| Deploy | Vercel (Cron Jobs incluidos) |
| SAST | FoxGuard (pre-commit hook) |

---

## Arquitectura

Arquitectura Hexagonal (Puertos y Adaptadores) organizada por scope de features:

```
src/
├── app/                              # Next.js App Router (capa de presentación)
│   ├── api/
│   │   ├── auth/[[...all]]/route.ts  # BetterAuth catch-all handler
│   │   └── webpay/
│   │       ├── checkout/route.ts     # POST — iniciar pago
│   │       ├── return/route.ts       # POST + GET — callback de Transbank
│   │       └── poll/route.ts         # GET — worker de recuperación (cron)
│   └── checkout/
│       ├── page.tsx                  # UI de checkout
│       ├── success/page.tsx          # Confirmación de pago (verifica BD)
│       └── error/page.tsx            # Pantalla de error
│
├── features/
│   ├── auth/                         # Módulo de autenticación
│   │   ├── auth.ts                   # Configuración de BetterAuth
│   │   └── infrastructure/
│   │       ├── email-service.ts           # Templates + envío de emails (Resend)
│   │       ├── upstash-secondary-storage.ts  # Adaptador Redis para sesiones
│   │       └── upstash-secondary-storage.test.ts
│   │
│   ├── webpay/                       # Módulo de pagos
│   │   ├── domain/
│   │   │   └── Transaction.ts        # Entidad + máquina de estados
│   │   ├── application/
│   │   │   └── transactionActions.ts # Casos de uso (Server Actions)
│   │   └── infrastructure/
│   │       ├── TransbankGateway.ts           # Adaptador HTTP → API Transbank
│   │       └── PrismaTransactionRepository.ts # Adaptador BD → Dominio
│   │
│   └── rate-limit/                   # Módulo de rate limiting
│       ├── domain/
│       │   ├── RateLimitGateway.ts    # Interfaz (intercambiable)
│       │   └── parseWindow.ts         # Parser de ventana compartido
│       └── infrastructure/
│           ├── UpstashRateLimitGateway.ts   # Adaptador Upstash
│           └── MemoryRateLimitGateway.ts    # Fallback para desarrollo
│
└── shared/
    ├── env.ts                        # Variables de entorno validadas con Zod
    ├── lib/prisma.ts                 # Singleton de Prisma client
    └── rate-limit.ts                 # Factory + helpers de rate limiting
```

### Flujo de Datos

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. INICIAR                                                          │
│    checkout/page.tsx                                               │
│    └── initiateTransactionAction(amount)                            │
│        ├── Crear WebpayTransaction (INITIALIZED)                   │
│        ├── Persistir ANTES de llamada a red                        │
│        ├── TransbankGateway.createTransaction() → token + URL       │
│        ├── Guardar token en BD                                      │
│        └── redirect() → formulario de pago de Transbank             │
├─────────────────────────────────────────────────────────────────────┤
│ 2. CONFIRMAR (callback de Transbank)                                │
│    POST /api/webpay/return?token_ws=<token>                         │
│    └── confirmTransactionAction(token)                               │
│        ├── A) Normal: commitTransaction() → AUTHORIZED | REJECTED   │
│        ├── B) 422: getTransactionStatus() → fallback, sin FAILED    │
│        └── C) Ya terminal: idempotente, retornar estado actual      │
├─────────────────────────────────────────────────────────────────────┤
│ 3. RECUPERAR (Vercel Cron)                                          │
│    GET /api/webpay/poll  [Authorization: Bearer <CRON_SECRET>]      │
│    └── pollStaleTransactionsAction()                                 │
│        └── Buscar INITIALIZED > 10 min → getTransactionStatus()     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Los 3 Escenarios de Return URL

Aquí es donde falla el 90% de las integraciones. Transbank puede llamar a la `return_url` de **tres formas diferentes**, y debe manejar todas:

| Escenario | Método HTTP | Parámetros |
|---|---|---|
| Pago completado (aprobado o rechazado) | `POST` | `token_ws=<token>` |
| Usuario presionó "Cancelar" en la página de pago | `POST` | `TBK_TOKEN=<t>` + `TBK_ORDEN_COMPRA=<bo>` + `TBK_ID_SESION=<s>` |
| Timeout (5 min sin acción del usuario) | `GET` | `TBK_TOKEN=<t>` + `TBK_ORDEN_COMPRA=<bo>` + `TBK_ID_SESION=<s>` |

> [!IMPORTANT]
> Cuando el usuario *cancela* o hay *timeout*, **`token_ws` NO está presente**. Si solo maneja `token_ws`, está ignorando dos de los tres escenarios.

---

## Máquina de Estados de Transacciones

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
> Una transacción `AUTHORIZED` **NUNCA puede revertirse a `FAILED`**. Si Transbank ya cobró y tu sistema falla después, debe llamar a `requestRefund()`. Un rollback de estado es un desastre contable y una violación de las políticas de Transbank.

---

## Tests

### Suite de Tests

| Módulo | Tests | Descripción |
|---|---|---|
| `Transaction.test.ts` | 24 | Máquina de estados del dominio |
| `transactionActions.test.ts` | 17 | Casos de uso de aplicación |
| `route.test.ts` | 12 | Handlers de rutas API |
| `upstash-secondary-storage.test.ts` | 14 | Adaptador Redis |
| `PrismaTransactionRepository.test.ts` | 8 | Adaptador de BD |
| `TransbankGateway.test.ts` | 6 | Adaptador HTTP Transbank |
| `auth.test.ts` | 18 | Autenticación BetterAuth |
| **Total** | **99** | |

### Ejecutar Tests

```bash
# Ejecutar todos los tests
bun run test

# Ejecutar con coverage
bunx vitest run --coverage

# Ejecutar un archivo específico
bunx vitest run src/features/webpay/domain/Transaction.test.ts
```

### Arquitectura de Tests

- **Tests unitarios**: Entidades de dominio, máquina de estados, casos de uso — sin dependencias externas
- **Tests de infraestructura**: Adaptadores Upstash con `fetch()` mockeado — sin Redis real
- **Tests de integración**: Handlers de rutas API con gateways mockeados — sin Transbank/BD real

---

## Seguridad

### Autenticación (BetterAuth)

| Característica | Configuración |
|---|---|
| Auth email/password | Habilitada |
| Verificación de email | Requerida antes del primer login |
| 2FA (TOTP + OTP) | Habilitada |
| Multi-session | Permitida (múltiples dispositivos) |
| Expiración de sesión | 7 días |
| Refresh de sesión | Cada 24 horas |
| Fresh age (re-auth) | 30 minutos para acciones sensibles |
| Cache de cookies | JWE encriptado (anti-tampering) |
| CSRF protection | Habilitada (sameSite: strict) |
| Rate limiting | 5 intentos/min para login, 3/min para registro |

### Rate Limiting

| Endpoint | Límite | Ventana |
|---|---|---|
| POST /api/auth/sign-in | 5 intentos | 1 minuto |
| POST /api/auth/sign-up | 3 intentos | 1 minuto |
| POST /api/webpay/checkout | 10 requests | 1 minuto |

### Variables de Entorno

- Todas las secrets validadas al startup con Zod (fail-fast)
- `BETTER_AUTH_URL`: sin default en producción (lanza error si falta)
- `RESEND_API_KEY`/`RESEND_FROM_EMAIL`: opcionales en dev, requeridas en producción
- Upstash: opcional en dev (fallback en memoria), requerido en producción

---

## Inicio Rápido

### Prerrequisitos

- [Bun](https://bun.sh) 1.x (o [Node.js](https://nodejs.org) 20+)
- PostgreSQL 14+ (local o cloud — [Neon](https://neon.tech) recomendado)
- Cuenta activa en [Portal de Desarrolladores Transbank](https://www.transbankdevelopers.cl)

### 1. Clonar e instalar

```bash
git clone https://github.com/Lostovayne/WebpayPlus-in-Next16.git
cd WebpayPlus-in-Next16
bun install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edit `.env` con sus valores. Ver `.env.example` para documentación completa de cada variable.

### 3. Configurar la base de datos

```bash
bunx prisma migrate dev
```

### 4. Iniciar el servidor de desarrollo

```bash
bun dev
```

Abra [http://localhost:3000/checkout](http://localhost:3000/checkout).

---

## Credenciales de Prueba

Estas son las credenciales oficiales públicas de Transbank para integración:

| Variable | Valor |
|---|---|
| `WEBPAY_COMMERCE_CODE` | `597055555532` |
| `WEBPAY_API_SECRET` | `579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C` |

**Tarjetas de prueba en el formulario de Transbank:**

| Tipo | Número | Resultado |
|---|---|---|
| VISA aprobada | `4051 8856 0044 6623` | Aprobada |
| VISA rechazada | `4197 0230 0000 0185` | Rechazada |
| Mastercard aprobada | `5186 0595 5959 0568` | Aprobada |

CVV: cualquier número de 3 dígitos. Vencimiento: cualquier fecha futura. RUT: `11111111-1`. Contraseña: `123`.

---

## Variables de Entorno

### Transbank

| Variable | Requerida | Default (dev) | Descripción |
|---|---|---|---|
| `WEBPAY_COMMERCE_CODE` | ✅ | `597055555532` | Código de comercio de Transbank |
| `WEBPAY_API_SECRET` | ✅ | Clave de integración | Secret key de la API |
| `WEBPAY_ENVIRONMENT` | ✅ | `integration` | `integration` o `production` |

### Base de Datos

| Variable | Requerida | Default (dev) | Descripción |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | URL completa de conexión PostgreSQL |

### Aplicación

| Variable | Requerida | Default (dev) | Descripción |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | ✅ | `http://localhost:3000` | URL base de la app (sin slash final) |
| `CRON_SECRET` | ✅ | — | Secret ≥ 32 chars para `/api/webpay/poll` |

### Upstash (Rate Limiting + Sesiones)

| Variable | Requerida | Default (dev) | Descripción |
|---|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Opcional | — | URL de Upstash Redis |
| `UPSTASH_REDIS_REST_TOKEN` | Opcional | — | Token de Upstash Redis |

### BetterAuth

| Variable | Requerida | Default (dev) | Descripción |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | ✅ | — | Secret de encriptación (≥ 32 chars) |
| `BETTER_AUTH_URL` | ✅ (prod) | `http://localhost:3000` | URL base para endpoints de auth |

### Resend (Email)

| Variable | Requerida | Default (dev) | Descripción |
|---|---|---|---|
| `RESEND_API_KEY` | Opcional* | — | API key de resend.com |
| `RESEND_FROM_EMAIL` | Opcional* | — | Email verificado para envío |

> *Opcional en desarrollo (loguea en vez de enviar). Requerido en producción.

> [!WARNING]
> Antes de ir a producción, **cambie** `WEBPAY_COMMERCE_CODE`, `WEBPAY_API_SECRET`, y configure `WEBPAY_ENVIRONMENT=production`. Las credenciales de integración no funcionan en producción.

---

## Schema de Base de Datos

### Tabla principal: `webpay_transactions`

```sql
CREATE TABLE webpay_transactions (
  id                  VARCHAR(36)     PRIMARY KEY,     -- UUID v7
  buy_order           VARCHAR(26)     UNIQUE NOT NULL, -- max 26 chars (Transbank)
  session_id          VARCHAR(61)     NOT NULL,
  amount              DECIMAL(17, 2)  NOT NULL,
  token               VARCHAR(64)     UNIQUE,          -- null hasta que Transbank lo retorne
  payment_url         TEXT,                             -- URL de redirección de Transbank
  status              VARCHAR(20)     DEFAULT 'INITIALIZED',

  -- Datos del callback de Transbank
  vci                 VARCHAR(10),                     -- código de verificación de integridad
  card_number         VARCHAR(19),                     -- últimos 4 dígitos
  accounting_date     VARCHAR(4),
  transaction_date    TIMESTAMP,
  auth_code           VARCHAR(6),
  payment_type_code   VARCHAR(2),
  response_code       INTEGER,
  installments_amount DECIMAL(17, 2),
  installments_number INTEGER,
  aborted_reason      VARCHAR(50),
  polled_at           TIMESTAMP,                       -- timestamp de última auditoría del worker

  created_at          TIMESTAMP       DEFAULT NOW(),
  updated_at          TIMESTAMP       -- auto-updated por Prisma
);

CREATE INDEX idx_transactions_status_created_polled
  ON webpay_transactions (status, created_at, polled_at);
```

### Tabla de auditoría: `transaction_audit_log`

```sql
CREATE TABLE transaction_audit_log (
  id                  VARCHAR(36)     PRIMARY KEY,
  transaction_id      VARCHAR(36)     NOT NULL,
  event_type          VARCHAR(50)     NOT NULL,   -- 'created', 'token_received', 'confirmed', 'aborted', 'polled', 'refunded', 'idempotent_redirect'
  event_data          JSONB,                      -- datos del evento
  created_at          TIMESTAMP       DEFAULT NOW(),

  FOREIGN KEY (transaction_id) REFERENCES webpay_transactions(id)
);
```

---

## Worker de Polling

El endpoint `GET /api/webpay/poll` resuelve el **escenario del usuario fantasma**: el usuario pagó en el banco pero perdió conexión (se cayó WiFi, se le murió el teléfono, cerró la pestaña) antes de volver a la `return_url`. Sin este worker, la transacción quedaría `INITIALIZED` para siempre aunque el dinero fue debitado.

**Cómo funciona:**

1. Vercel Cron lo llama cada 5 minutos (configurado en `vercel.json`)
2. Busca transacciones en `INITIALIZED` por más de 10 minutos
3. Para cada una, llama a `GET /transactions/{token}` en Transbank
4. Actualiza el estado según la respuesta (`AUTHORIZED`, `REJECTED`, o difiere al próximo ciclo)
5. Después de 7 días, si Transbank no responde, marca como `FAILED` (la API de estado ya no está disponible)

**Invocación manual en desarrollo:**

```bash
curl -X GET http://localhost:3000/api/webpay/poll \
  -H "Authorization: Bearer tu_cron_secret"
```

---

## Deploy a Vercel

### 1. Configurar variables de entorno

En el dashboard del proyecto → **Settings → Environment Variables**, agregue todas las variables de `.env.example` con valores de producción.

### 2. Verificar Cron Jobs

El archivo `vercel.json` configura el cron automáticamente. Verifique que tu plan de Vercel soporte Cron Jobs (Pro o superior).

### 3. Deploy

```bash
vercel --prod
# O simplemente pushee a main con CI/CD configurado
git push origin master
```

---

## Comandos Disponibles

```bash
bun dev          # Servidor de desarrollo con Turbopack (http://localhost:3000)
bun build        # Build de producción
bun start        # Servidor de producción
bun test         # Ejecutar todos los tests (Vitest)

# Prisma
bunx prisma migrate dev --name <nombre>   # Nueva migración
bunx prisma generate                       # Regenerar cliente
bunx prisma studio                         # GUI de BD en navegador
bunx prisma migrate status                 # Estado de migraciones
```

---

## Anti-Corruption Layer

`TransbankGateway` es el único archivo que sabe que Transbank existe. El dominio y la aplicación trabajan con interfaces limpias:

```typescript
// ✅ El dominio solo conoce esto:
interface WebpayInitResponse {
  token: string;
  url: string;
}

// ✅ Y el caso de uso solo hace esto:
const { token, url } = await gateway.createTransaction(buyOrder, sessionId, amount, returnUrl);

// ❌ Nunca esto en el dominio o la aplicación:
fetch("https://webpay3g.transbank.cl/...", { headers: { "Tbk-Api-Key-Id": ... } });
```

Si Transbank cambia su API, URL, o headers mañana, **solo toque `TransbankGateway.ts`** — el resto del sistema no se entera.

---

## Manejo de Errores 422

El 422 de Transbank merece atención especial. Su documentación dice:

> *Si el comercio reintenta el commit de una transacción ya confirmada, recibirá HTTP 422.*

Esto pasa más seguido de lo que piensa: doble clic del usuario, reload de página, reintento del worker, caída de red después del commit. El enfoque correcto **no es** marcar `FAILED` — es consultar el estado real:

```typescript
try {
  const response = await gateway.commitTransaction(token);
  // Flujo normal...
} catch (error) {
  if (error instanceof TransbankAlreadyProcessedError) {
    // 422: ya procesada → recuperar estado real sin marcar FAILED
    const status = await gateway.getTransactionStatus(token);
    // Ahora sí actualizamos el estado correctamente
  }
}
```

---

## Limitaciones de la API de Transbank

| Restricción | Valor | Impacto |
|---|---|---|
| `buy_order` máximo | 26 caracteres | Validado en dominio |
| `session_id` máximo | 61 caracteres | UUID v4 = 36 chars ✅ |
| Monto máximo CLP | 999,999,999 | Validado en dominio |
| Monto mínimo | > 0 | Validado en dominio |
| Disponibilidad de estado (`GET /transactions/{token}`) | 7 días desde creación | El worker respeta esto |
| Reembolso (`POST /transactions/{token}/refunds`) | Mismo día hábil para reversión; anulación tiene reglas distintas | No ignorar en producción |

---

## Roadmap

### Completado ✅

- [x] Integración Webpay Plus REST API v1.2
- [x] Manejo de los 3 escenarios de return URL
- [x] Idempotencia con P2002 race condition
- [x] Polling worker para transacciones abandonadas
- [x] BetterAuth (email/password, 2FA, multi-session)
- [x] Rate limiting (Upstash Redis + memoria)
- [x] Pino structured logging
- [x] Audit trail completo
- [x] 99 tests con Vitest
- [x] FoxGuard SAST (pre-commit)

### Próximos pasos 🔜

- [ ] Observabilidad Datadog (métricas, traces, dashboards) — [#17](../../issues/17)
- [ ] Docker para tests de integración
- [ ] Webhook de confirmación de Transbank
- [ ] Dashboard de administración de transacciones
- [ ] Soporte para Webpay Plus Mall (multi-sucursal)

---

## Contributing

1. Forkee el repositorio
2. Cree una branch: `git checkout -b feat/mi-mejora`
3. Commitee los cambios: `git commit -m "feat: descripción"`
4. Publique: `git push origin feat/mi-mejora`
5. Abra un Pull Request

Antes de enviar, verifique que los tests pasen:

```bash
bun test
```

---

## Licencia

MIT — úselo, modifíquelo, véndalo si lo desea. Solo no venga a quejarse cuando no manejó el 422.

---

<div align="center">

Integración de pagos para Chile 🇨🇱 con [Transbank Webpay Plus](https://transbankdevelopers.cl)

**Hecho con Next.js 16, TypeScript, Prisma 7, y BetterAuth**

</div>
