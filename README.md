# Group Trip Planner

A small group plans one trip together in a shared chat. The planner keeps a
calendar, per-person attendance and budgets, and — once the extraction loop
lands — turns what people actually agreed to in chat into calendar changes.

[architecture.md](architecture.md) is the source of truth for system behavior.
[plan.md](plan.md) owns sequencing and progress. [AGENTS.md](AGENTS.md) is the
engineering contract.

Status: **M0 (foundation) implemented.** Anonymous identity, trips, invites,
joins, chat and the shared contracts work end to end. Events, the calendar,
Gemini extraction, place enrichment and the map are not built yet.

## Layout

| Path | Owns |
| --- | --- |
| `packages/contracts` | Zod request/response/error/resource schemas, shared limits, the model operation envelope. No credentials, no database, no SDKs. |
| `packages/db` | Drizzle schema, versioned migrations, constraints, RLS, the migration CLI. |
| `apps/server` | Fastify HTTP API, domain services, and the separate local worker entry point. |
| `apps/web` | React + Vite browser app. |
| `api/index.ts` | Vercel Node function that serves the Fastify app. |
| `tests` | Unit, real-Postgres integration, and Playwright end-to-end tests. |

HTTP and background work are separate entry points on purpose: importing the
HTTP app starts no scheduler and no timer.

## Requirements

- Node.js 22.12 or newer (below 26). `node -v`.
- npm 10 or newer.
- A PostgreSQL 15+ instance for integration tests. `scripts/test-db.sh` can
  start a disposable one for you.

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
```

`.env` is gitignored and must never be committed. Every command below reads it
from the repository root.

### What each consumer needs

| Consumer | Values | Notes |
| --- | --- | --- |
| Browser bundle | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, optional `VITE_API_BASE_URL` | Only public values may carry the `VITE_` prefix. Vite reads these from the root `.env`. |
| HTTP API | `DATABASE_URL` (restricted `trip_api` role, transaction pooler on 6543), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ALLOWED_ORIGINS`, `APP_REVISION` | No Gemini key. `GEOAPIFY_API_KEY` only if `PLACES_ENABLED=true`. |
| Local worker | `DATABASE_URL_WORKER` (restricted `trip_worker` role, session/direct connection on 5432), `GEMINI_API_KEY`, `LLM_MODEL`, `PROCESSING_MODE`, daily provider ceilings | Set `LLM_ENABLED=false` or `PLACES_ENABLED=false` to run deliberately without a provider. |
| Migrations | `MIGRATION_DATABASE_URL` | A separate privileged credential. Never the API or worker role. |
| Integration tests | `TEST_DATABASE_URL` | A throwaway database. The harness refuses to run against a Supabase host. |

Each entry point validates only what it uses, and fails at startup with the
names of the missing values — never their contents.

## Database

Migrations are a controlled deployment step. They never run on function
invocation or worker startup.

```bash
npm run db:generate   # after editing packages/db/src/schema.ts
npm run db:migrate    # applies pending migrations using MIGRATION_DATABASE_URL
```

Before running migrations against a hosted project, confirm which project
`MIGRATION_DATABASE_URL` points at and whether it already holds data. The
command prints the host and database, with the credential redacted.

### Runtime roles

`0001_security.sql` creates two `NOLOGIN` group roles, `trip_api` and
`trip_worker`, and grants each only what it needs. It deliberately creates no
login role and no password. Create the login roles yourself and grant
membership, choosing passwords outside this repository:

```sql
-- run once, as the project owner, with passwords you generate
create role trip_api_user login password :'api_password' in role trip_api;
create role trip_worker_user login password :'worker_password' in role trip_worker;
```

Then put their connection strings in `DATABASE_URL` and `DATABASE_URL_WORKER`
locally, and in the Vercel project settings for deployment.

Check what a credential can actually do, without printing it:

```bash
npm run db:check-roles
```

It reports the role, whether it bypasses RLS, whether it owns tables (an owner
is not subject to RLS), and its privileges per table. Provisioned keys are not
evidence of correct privileges.

## Running locally

```bash
npm run dev:api      # Fastify on 127.0.0.1:3000
npm run dev:web      # Vite on 127.0.0.1:5173, proxying /api and /health
npm run dev:worker   # the persistent local worker
```

The worker connects outbound to the database and providers, so nothing needs to
reach your laptop. Stopping it pauses processing and leaves queued work in the
database; starting it again resumes. While it is down, chat and manual planning
keep working and trips report processing as `unavailable`.

## Verification

```bash
./scripts/verify.sh
```

Runs formatting, lint, strict typecheck, unit tests, integration tests and the
production build. A check that cannot run is reported as a failure, never as a
pass. Set `RUN_E2E=1` to include the Playwright suite.

### Running the integration tests

They need a real PostgreSQL and they reset it destructively, so they refuse to
run against a Supabase host.

```bash
./scripts/test-db.sh start          # prints a TEST_DATABASE_URL
export TEST_DATABASE_URL=...        # the value it printed
npm run test:integration
./scripts/test-db.sh stop           # or destroy, to delete the cluster
```

The harness creates the `anon` and `authenticated` roles and an empty
`supabase_realtime` publication before migrating, so the RLS policies and the
publication take exactly the branches they take on hosted Supabase.

### End-to-end tests

```bash
npx playwright install chromium   # once
npm run test:e2e
```

These use a real Supabase project for anonymous sign-in.

## Deployment

The UI and API deploy to Vercel from `vercel.json`; the worker runs on the
presenter's laptop from the same source revision. `APP_REVISION` must match
across both, because the API only trusts a worker heartbeat from a compatible
revision.

Deployed smoke testing, the demo runbook and the outage drill belong to the
release milestone and are not done yet.

## Known dependency advisory

`npm audit` reports a moderate advisory against the old esbuild bundled inside
`drizzle-kit`. It affects a development-only CLI that never runs in production
or in CI request paths, and the suggested fix downgrades `drizzle-kit` by many
major versions. Accepted for now; revisit if `drizzle-kit` ships a newer
esbuild.
