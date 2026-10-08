# Vercel deployment

This fork supports Neon PostgreSQL for persistent providers, API keys, settings,
usage and request details. Local installations keep using SQLite when no
PostgreSQL URL is configured.

Connect a Neon database through the Vercel Marketplace. It supplies
`DATABASE_URL` (pooled runtime connections) and `DATABASE_URL_UNPOOLED` (schema
migrations). Set these additional variables in Production and Preview:

| Variable | Value |
| --- | --- |
| `NINEROUTER_DB_DRIVER` | `postgres` |
| `JWT_SECRET` | A strong, randomly generated secret shared by all functions |
| `INITIAL_PASSWORD` | A strong initial dashboard password |
| `AUTH_COOKIE_SECURE` | `true` |
| `DATA_DIR` | `/tmp/9router` (scratch files only) |
| `BASE_URL` | The application's production HTTPS URL |

Use the Next.js framework preset, Node.js 24 and `npm run build`.
PostgreSQL initializes its tables automatically under an advisory lock. Database
connection or migration failures fail closed; they do not switch to temporary
SQLite storage.

Production, Preview and Development use separate application schemas
(`nine_router`, `nine_router_preview`, `nine_router_development`). Override
`NINEROUTER_DB_SCHEMA` when additional isolation is needed. Previews share their
preview schema unless an override or a separate Neon branch is configured.

After deployment, verify dashboard login, provider storage, API key creation and
authenticated `GET /v1/models`. Connect a provider to use inference. Features
that require a local desktop, installed binaries, MITM certificates or a
permanently running background process should run in a local installation.

The opt-in integration test `tests/integration/neon-db.test.js` accepts
`TEST_NEON_DATABASE_URL` and optional `TEST_NEON_DIRECT_URL`, creates a temporary
schema, verifies persistence and transactions, and removes that schema afterward.
Do not commit environment files or dashboard credentials.
