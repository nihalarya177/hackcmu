# Demo runbook

How to run, rehearse and recover the Pittsburgh trip-planner prototype.

## What this is

A four-person trip-planning prototype with two explicit modes.

| Mode | What it is | What may be claimed |
| --- | --- | --- |
| **Demo** (default) | A simulated trip held in the browser. No account, no API, no database, no AI provider. Scripted outcomes play back on named scenarios. | An interactive product prototype with simulated participants and simulated planning outcomes. |
| **Live** | The real API, Supabase Auth and database. | Only onboarding and chat. Everything else is unbuilt server work and is hidden, not faked. |

The Demo badge is in the header the whole time, and the amber bar at the
bottom carries every demo-only control. Nothing in Demo mode reaches a server
except OpenStreetMap tiles for the map.

## Start it

```bash
npm ci
npm run build          # typecheck + production bundle
npm run preview -w @trip/web -- --port 4173 --strictPort
```

Open <http://127.0.0.1:4173/>. That is the whole demo — no `.env`, no database,
no worker. `?mode=demo` and `?mode=live` force a mode; the last choice is
remembered per browser.

For live mode as well, put the two `VITE_SUPABASE_*` values in the repository
root `.env` (see `.env.example`) and run the API alongside it:

```bash
npm run dev:api        # needs the server entries in .env
```

## Rehearse (about four minutes)

Press **Reset demo** in the amber bar first, every time.

1. **Four people.** Budgets down the left: Ana $400, Ben $120, Cleo $600,
   Dev $300. Friday evening and a Sunday conservatory visit are already planned.
2. **Agreement.** Ana and Ben have already asked for the museum in chat. Type
   anything you like, then press **Update plan**.
   → Carnegie Museum of Art, Saturday 10:00, for the two of them.
3. **The split.** Press **Update plan** again.
   → Cleo and Dev take the Duquesne Incline at the same time. The calendar shows
   two groups; the map shows two branches.
4. **Overspend.** Scenarios → *A pricey dinner pushes Ben over his budget*.
   → Ben goes to $205 against $120 and turns red; the warning list explains it.
5. **Double booking.** Scenarios → *Dev joins the museum while already on the
   incline*. → Dev is booked twice at once.
6. **Correct something.** Click the museum block, change its end time, save.
   → Calendar, budgets, warnings and map all agree again, and the event is now
   marked as human-scheduled.
7. **Map.** Map tab → *Sat 10 Oct*. Real OpenStreetMap tiles, one marker per
   stop coloured by who is going, the dinner listed as having no location yet.
8. **Remove and bring back.** Scenarios → *suggests dropping the dinner*, press
   **Remove**, then Scenarios → *brings the dinner back*, then **Undo**.
9. **Export.** **My calendar** downloads a real `.ics` for whoever you are
   acting as. Switch participant and download again — it is a different file.
10. **Reload the page.** Everything survives. **Reset demo** returns to step 1.

To rehearse without typing, every step is in the **Scenarios** menu. A scenario
that builds on another is greyed out until its prerequisite has played.

## Supported capabilities

| | Demo | Live |
| --- | --- | --- |
| Chat, own profile, trip settings | yes | yes |
| Create / join / invite | no | yes |
| Manual events, restore, own attendance | yes | no |
| Update plan (scripted) | yes | no |
| Venue correction, stored actions, export, map | yes | no |
| Participant switching, reset | yes | no |

The UI reads these from the adapter, so anything unavailable is hidden rather
than offered and then failing.

## Limitations, stated plainly

- **Demo outcomes are scripted, not generated.** Seven named scenarios match
  fixed keywords over the transcript. Anything else gets "no scripted demo
  scenario matches that yet" — it never improvises a plan. No model is called.
- **Venue coordinates** come from Wikipedia, checked 2026-09-12, and are stored
  as manual entries. **Opening hours are unknown** unless someone records them
  in the app. **Prices are illustrative estimates**, not quoted prices.
- Demo state lives in one browser. It is not shared between devices or people.
- Live mode has onboarding and chat only. Hosted migrations have not been
  applied and restricted database roles do not exist yet (see `plan.md`).
- No place search provider, and no `.ics` import.

## Recovery

| Problem | What to do |
| --- | --- |
| Demo looks wrong or half-played | **Reset demo** in the amber bar. |
| A scenario is greyed out | Its prerequisite has not played; use the menu in order. |
| "Update plan" does nothing | A run is already in flight; wait for it to finish. |
| Map is blank or grey | Tiles need internet. The stop list below stays correct, and the page says so. |
| Live mode shows a configuration error | Expected without `.env`. Press **Open the demo instead**. |
| Anything unexplained | Reload the page, then **Reset demo**. |

## Deploying to Vercel

`vercel.json` is configured and the build output has been verified against
those rewrite rules locally. **It has never actually been deployed**, and
deploying needs Kartik's Vercel account, so it is not done here.

```bash
npm i -g vercel      # the CLI is not installed on this machine
vercel login
vercel link          # pick the target project
vercel --prod
```

Configuration: build `npm run build`, install `npm ci`, output
`apps/web/dist`, with `/api/*` and `/health/*` rewritten to the Node function
and everything else falling back to `index.html`. Give the project an LTS Node
runtime (22.x) rather than matching this machine's Node 25.

**Demo mode does not depend on the deployment's backend.** Verified by serving
the production bundle under those exact rewrite rules with the function
returning 502 for every `/api` and `/health` request: the planner loads, Update
plan runs, the map draws, the export downloads, and a deep link falls back to
the app. Set no environment variables at all and demo mode still works — the
build succeeds without them and live mode reports the missing configuration.

For live mode on the deployment, set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` (build-time, public) plus the server entries
from `.env.example`, and verify separately:

- anonymous sign-in reaches Supabase,
- `GET /health/ready` answers through the rewrite,
- creating a trip persists and returns a snapshot.

Until those pass on the deployment, present Demo mode.

## Verification

```bash
./scripts/test-db.sh start                       # prints TEST_DATABASE_URL
TEST_DATABASE_URL=… RUN_E2E=1 ./scripts/verify.sh
./scripts/test-db.sh stop
```

Integration tests use a disposable local Postgres under `.tmp/` and refuse to
run against a Supabase host.
