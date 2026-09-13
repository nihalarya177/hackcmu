# Group Trip Planner

A small group plans one trip together in a shared chat. The planner keeps a
calendar, per-person attendance and budgets, and turns what people actually
agreed to in chat into calendar changes.

[architecture.md](architecture.md) is the source of truth for system behavior.
[plan.md](plan.md) owns sequencing and progress. [AGENTS.md](AGENTS.md) is the
engineering contract.

Status: **M1-M4 implemented and deployed.** Anonymous identity, trips, invites,
joins, chat, events, the calendar, Gemini extraction, place enrichment, the map
and `.ics` export work end to end. Known gaps are listed under
[Known gaps](#known-gaps).

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

## How it works

[architecture.md](architecture.md) is the full specification. This section is
orientation: what talks to what, and which decisions are load-bearing.

### Four tiers

| Tier | Runs on | Reached by |
| --- | --- | --- |
| Browser app | Vercel static hosting | People |
| HTTP API | Vercel Node function | The browser, same-origin under `/api` |
| Postgres, Auth, Realtime | Supabase | The function and the browser |
| Worker | A long-lived process, outbound only | Nothing — it reaches out |

The worker is not a server. It opens no port and accepts no connection; it polls
the database for due work and calls providers outbound. That is why it can run
anywhere with network access, including a laptop behind NAT.

### A message, end to end

A send is written to Postgres with a client-generated nonce, and the browser
draws it immediately at reduced opacity as `sending…`. It is never drawn as
though it were saved. When the committed row comes back carrying the same nonce,
the optimistic copy retires instead of rendering twice. A failed send keeps the
text with a retry.

Other browsers learn about it through Supabase Realtime, which publishes exactly
two tables: `trip` and `message` (`0001_security.sql`). A change wakes the
client, which then refetches the authoritative read over HTTP — realtime is the
signal, not the payload, so a dropped or out-of-order frame cannot corrupt what
is on screen. Polling at `CLIENT_POLL_MS` is the floor beneath that, not the
mechanism.

Publishing only those two tables is deliberate and sufficient: every plan change
bumps `trip.calendar_version`, so one published row signals all of them.

### Why extraction is a separate process

The API never calls Gemini. Sending a message marks the trip as needing
planning; the worker does the rest.

Three triggers, all evaluated in the database so two workers cannot both decide a
trip is due: the manual **Update plan** button, a pending-message count, and
conversational inactivity. Thresholds come from `PROCESSING_SETTINGS`
(`normal`: 10 messages or 15 minutes; `demo`: 3 messages or 20 seconds).

A worker claims a trip by writing a **lease** — its own id and an expiry — and
every subsequent write is fenced on that token. The batch captures a fixed
message range at claim time and never widens it, so a retry replays identical
work rather than chasing a moving target. Nothing lives in process memory: kill
the worker mid-batch and the lease expires, another claim picks it up, and no
partial state survives.

This also means the design scales horizontally without change. The constraint
today is operational, not architectural.

### The model's output is not trusted

Gemini returns structured operations against a `responseSchema`, and
`applyEnvelope` re-checks every field against database state before writing. An
operation referring to a person who is not a member, or an event that no longer
exists, is rejected. One bad operation is discarded with a reason; the rest still
apply. Rejections are summarised into plain English and posted into the chat, so
a failed extraction is visible rather than silent.

The prompt instructs the model to ask a clarifying question when it is unsure
rather than invent a plausible detail.

### Concurrency

Two mechanisms, both in [architecture.md](architecture.md) §7:

- **Optimistic concurrency.** Every mutation sends the `calendar_version` it was
  looking at. If the plan has moved, the write is refused with `STALE_VERSION`
  instead of clobbering someone else's edit.
- **Idempotency.** Every mutation carries a key. Replaying a request that already
  succeeded returns the original receipt rather than performing it twice.

### Time

Events store a **local date and minute** plus the trip's zone; the UTC instants
are derived server-side and are never client-supplied. Local times that do not
exist — 02:30 on a spring-forward day — are rejected rather than silently rolled
forward. The calendar renders through `@fullcalendar/luxon3`, without which
FullCalendar draws a named zone as UTC.

### Failure is visible

A deliberate stance, and the reason several surfaces look the way they do: there
are no placeholder success states. A stopped worker greys out **Update plan** and
reports processing as `unavailable` rather than appearing to think. A rejected
operation says which and why. An unsent message says `not sent`.

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

On the hosted project these login roles were never created: both URLs resolve to
`postgres`, which has `bypassrls = true`. See [Known gaps](#known-gaps).

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

The UI and API deploy to Vercel from `vercel.json`; the worker runs as a
separate long-lived process elsewhere.

```bash
vercel link          # once, at the repository root
vercel --prod
```

Set in the Vercel project: `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `GEOAPIFY_API_KEY`, `PLACES_ENABLED`,
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_CARTO_API_KEY`.

`GEMINI_API_KEY`, `DATABASE_URL_WORKER`, `LLM_MODEL` and
`MIGRATION_DATABASE_URL` are worker- and operator-only. They do not belong on
the web host, and the API does not read them.

**Leave `APP_REVISION` unset on both sides unless you set it on both.**
`hasCompatibleWorker` (`apps/server/src/domain/snapshot.ts`) requires an exact
match between the API's revision and the worker's heartbeat, and both default to
`dev`. Setting it on the web host alone makes every running worker invisible and
**Update plan** reads as unavailable.

The three `VITE_` values are public by nature — they are compiled into the
browser bundle — so `vercel env add` needs `--type config` for them. It prompts
interactively for the value when `--type` is given and ignores piped stdin.

Restrict the CARTO key to the deployment domain once the URL is known. Domain
restriction, not storage, is what protects a key that ships in a bundle.

### Post-deploy checks

```bash
curl -s "$BASE/health/ready"                      # {"status":"ok","database":true}
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/some/deep/link"   # 200, SPA fallback
```

`/health/ready` exercises the `/health/(.*)` rewrite and the function's database
connection in one call, which is the check most likely to catch a broken
deployment. Then create a trip, open the invite in a second browser profile, and
confirm **Update plan** is enabled with a worker running.

## Known gaps

Recorded rather than hidden. None of these are in the code path's design; they
are unfinished operational work.

- **RLS is written but not enforced.** All 16 tables carry policies, and
  `0001_security.sql` creates the `trip_api` and `trip_worker` group roles, but
  the restricted login roles were never created on the hosted project. Both
  connection strings resolve to `postgres`, which bypasses RLS. Tenant isolation
  therefore rests entirely on the application-layer membership check, with no
  database backstop if a handler ever forgets one. Closing this is the
  `create role ... in role trip_api` step above.
- **An anonymous identity cannot be recovered.** The session is the identity, so
  clearing browser data loses access to every trip with no recovery path.
  Supabase supports linking an anonymous user to a real identity in place,
  keeping the same `user.id`; that is the fix, and it is not implemented.
- **`MIGRATION_DATABASE_URL` points at `db.<ref>.supabase.co`**, which no longer
  resolves over IPv4. Future migrations need the pooler host instead.
- **A stale tab recovers on focus, not on a timer.** `pollUnlessFailed` stops
  polling once a query is in `error` state, by design; `refetchOnWindowFocus`
  restarts it. Nothing on screen distinguishes a live tab from a quiet one.
- **No aggregate observability.** Failures surface to the user well and to the
  operator not at all. `batch_run.rejections` is the highest-value signal and is
  only reachable by querying the database directly.
- **Latency is round trips, not compute.** Every API request makes a network
  call to Supabase Auth before any handler runs (`auth/verifier.ts`), chosen so
  that revocation is honoured. Local JWKS verification is the standard fix.

## Known dependency advisory

`npm audit` reports a moderate advisory against the old esbuild bundled inside
`drizzle-kit`. It affects a development-only CLI that never runs in production
or in CI request paths, and the suggested fix downgrades `drizzle-kit` by many
major versions. Accepted for now; revisit if `drizzle-kit` ships a newer
esbuild.
