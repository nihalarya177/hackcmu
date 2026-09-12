# Trip Planner — running it

A conversation-first trip planner. A group talks; what they agree on becomes a
calendar, a budget and a map.

## What actually runs

| Piece | What it is | Where |
| --- | --- | --- |
| Web app | React, FullCalendar, Leaflet | `apps/web` |
| API | Fastify, deployed as the Vercel Node function | `apps/server/src/http` |
| Worker | Persistent background process. Reads the conversation, resolves venues. | `apps/server/src/jobs` |
| Database | PostgreSQL / Supabase, 16 tables with RLS | `packages/db` |

Identity is an anonymous Supabase session. The worker runs on a laptop and
connects outbound; nothing needs to reach it.

## Start it locally

```bash
npm ci

# 1. A disposable database, and the schema in it.
./scripts/test-db.sh start                  # prints TEST_DATABASE_URL
MIGRATION_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/trip_test npm run db:migrate

# 2. The API and the worker, both pointed at it.
export DATABASE_URL=postgresql://postgres@127.0.0.1:5433/trip_test
export DATABASE_URL_WORKER=postgresql://postgres@127.0.0.1:5433/trip_test
export PROCESSING_MODE=demo                 # 3 messages / 20s triggers
export PLACES_ENABLED=true
npm run dev:api                             # terminal 1
npm run dev:worker                          # terminal 2

# 3. The web app.
npm run dev:web                             # terminal 3 → http://localhost:5173
```

`.env` supplies `VITE_SUPABASE_*` for anonymous auth, `GEMINI_API_KEY` and
`GEOAPIFY_API_KEY`. Everything else has a default.

Against the production bundle instead: `npm run build && npm run preview -w
@trip/web -- --port 4173`.

## Walk through it

1. **Start a trip.** Name it, pick dates, say who you are and what you can spend.
2. **Invite.** The button mints a link and copies it. Open it in a different
   browser profile — that is a different anonymous identity, which is what
   makes it a real second person.
3. **Talk.** Both people say what they want. Messages appear in the other
   session without a reload.
4. **Update plan.** The worker reads the conversation and proposes operations.
   Two people must each have said yes in their own message before anything is
   committed on their behalf.
5. **Plan by hand too.** Click any empty slot to add an event. Click an event
   for its controls: going / not going / undecided, the roster, the warnings
   that concern it, and remove.
6. **Watch the budgets.** They are per person, in integer cents, and split
   estimates from prices someone stands behind.
7. **Map.** Venues named in words are resolved by the worker, with opening
   hours for the exact trip dates. A stop with no location says so rather than
   being guessed onto the map.
8. **My calendar.** Downloads a real `.ics` of your own attended events.

## What is true, and what is not

- **The AI is real.** `gemini-3.5-flash-lite`, structured output, called from a
  durable worker with leases and bounded retries. Nothing is scripted.
- **It refuses more than it accepts, on purpose.** Consent must be evidenced by
  a message that person actually wrote; two people minimum; something in the
  current batch must trigger it; human schedule locks and human attendance
  choices win; duplicates and previously deleted occurrences are refused.
- **Venue data is the provider's.** Coordinates and opening hours come from
  Geoapify. Where no schedule can be read, hours stay **unknown** — which is
  deliberately not the same as closed.
- **Prices are never invented.** The model may only pass on a price someone
  stated, and it is recorded as an estimate.
- **Not built:** deployment (see below), a seeded demo trip, and the outage
  drill.

## Verification

```bash
./scripts/test-db.sh start
DATABASE_URL=postgresql://postgres@127.0.0.1:5433/trip_test \
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/trip_test \
RUN_E2E=1 ./scripts/verify.sh
```

Runs formatting, lint, strict typecheck, unit tests, real-Postgres integration
tests, the production build and Playwright. A check that cannot run is reported
as a failure, never as a pass.

The live provider tests are kept out of that run because they cost real
requests:

```bash
RUN_LLM=1 GEMINI_API_KEY=… LLM_MODEL=gemini-3.5-flash-lite \
TEST_DATABASE_URL=… npx vitest run --project integration extractionLive
```

## Recovery

| Problem | What to do |
| --- | --- |
| "Update plan" is greyed out | No worker is running. Start `npm run dev:worker`. The app says so rather than pretending. |
| Extraction says it failed | It retries automatically twice. `Try again` forces another attempt. |
| A venue stays "no location yet" | `PLACES_ENABLED=true` and a Geoapify key are needed; otherwise correct it by hand from the event panel. |
| Chat or calendar looks stale | Realtime is a hint only; everything re-reads every five seconds regardless. |
| An edit is refused as stale | Somebody else moved first. The view refreshes and your draft is kept. |
