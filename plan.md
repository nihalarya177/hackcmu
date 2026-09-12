# Implementation Plan

Updated: 2026-09-12. M0 implemented and verified locally. M1 is next.

## Authority and Current Objective

Build the controlled-demo Group Trip Planner described in [architecture.md](architecture.md). That document owns system behavior and explicitly resolves conflicts with the [original product specification](.claude/agents/trip-planner-v1.md). This plan owns sequencing, assignments, acceptance gates, and progress. Kartik owns final product and technical decisions.

Before coding, read `AGENTS.md`, `architecture.md`, this plan, and the relevant agent instructions. Read `CLAUDE.md` when working through Claude Code. Surface material conflicts instead of silently changing the architecture.

M0 (foundation and contract freeze) is implemented and verified against a real PostgreSQL 17 and the live Supabase anonymous Auth project. The immediate objective is now **M1: the manual planner vertical slice**. Prove a usable manual planner before connecting automatic extraction to calendar mutations.

## Confirmed Decisions and Setup Status

| Item | Decision / status |
| --- | --- |
| Product and architecture | Defined; implement architecture amendments, not superseded product rules. |
| Repository | User reports GitHub setup complete for `nihalarya177/hackcmu`; local branch tracks `origin/main`. |
| Credentials | User reports Supabase, Gemini, and Geoapify values in a local `.env`. Values and live connectivity have not been verified by this handoff. |
| Database | Supabase Postgres, anonymous Auth, and Realtime. No MongoDB. Schema, restricted runtime roles, RLS, and migrations remain implementation work. |
| UI/API | React/Vite frontend and Fastify API on Vercel; same-origin `/api`. Hosting setup is user-reported, not a passed application deployment test. |
| Background work | One persistent local Node worker connects outbound to Supabase and providers. No laptop tunnel; no worker inside a Vercel request. |
| LLM | Gemini through `@google/genai`. User-selected testing candidate: `LLM_MODEL=gemini-3.5-flash-lite`. Verify the exact ID, access, structured-output support, and limits against the provided project. Do not silently substitute a model. |
| Places | One Geoapify key for Geocoding and Place Details. Manual/seed data remain usable without the provider. |
| Deferred infrastructure | No Railway, Turnstile, or Supabase Cron for this controlled-demo implementation. Cron would replace the scheduler through an approved architecture change, not run alongside it. |
| Current code | Workspaces, shared contracts, database schema/migrations/RLS, identity and mutation foundation, and the verification harness are implemented. `./scripts/verify.sh` runs six real checks and passes. Events, calendar, extraction, enrichment and map are not implemented. |
| Runtime roles | Migration `0001_security.sql` creates the `trip_api` and `trip_worker` group roles with scoped grants. **Login roles do not exist yet**: `DATABASE_URL` currently resolves to `postgres` with `bypassrls=true` (verified by `npm run db:check-roles`). |
| Node | Pinned to `>=22.12 <26` in `engines`. The development machine runs 25.9.0, which is outside Node LTS; Vercel should be given an LTS runtime. |

Never read credentials into tool output, paste them into chat, commit `.env`, or expose them through browser bundles/logs. Verify configuration with redacted presence checks and narrowly scoped connectivity tests. Setup completion is not evidence that credentials have the right privileges.

## Ownership and Coordination

| Owner | Scope |
| --- | --- |
| Backend agent | `apps/server`, `packages/db`, migrations, auth, domain rules, worker, provider adapters, integration tests. Own shared contracts and root tooling initially. |
| Frontend agent | `apps/web`, accessible application flows, query/realtime reconciliation, UI tests, visual verification. Review shared contracts before feature implementation. |
| Adversary agent | Independent read-only review of isolation, concurrency, consent, recovery, and acceptance evidence; report severity, reproduction, and remediation. |
| Release agent | Integrated verification, deployed smoke tests, demo runbook, secret checks, and SHIP / DO NOT SHIP recommendation. |
| Kartik | Material architecture/scope/model decisions, account permissions, final acceptance. |

Use the existing role instructions in `.claude/agents/`. These are roles, not a requirement to launch agents simultaneously. One agent may execute multiple roles sequentially; independent review should remain separate when available.

- Assign one owner to each active task. The first implementer records the task ID and scope in Active Work before editing.
- M0 owns the workspace layout, lockfile, shared contracts, and database schema. Frontend reviews request/snapshot/error shapes before parallel feature work begins.
- Avoid concurrent edits to root configuration, shared schemas, migrations, or this progress file. Route contract changes through the designated owner and notify dependents.
- Each milestone needs tests with its implementation. Do not defer foundational authorization or concurrency tests to release.
- Complete means accepted and verified, not merely coded. Record verification commands/results, remaining issues, and handoff notes when checking a task off.
- Preserve unrelated user changes, including the existing untracked `design/` references. Inspect those references for frontend direction without modifying or committing them implicitly.

## Critical Path

`M0 Foundation -> M1 Manual planner -> M2 Durable extraction -> M3 Enrichment and map -> M4 Release`

After M0, frontend and backend can work against agreed contracts. Prompt/evaluation fixtures can run in parallel with M1 once operation schemas are fixed. M3 projection tests and UI shells can also start early; integration must use the canonical server projection. All milestones below are P0 for the agreed demo. Optional polish must not displace correctness gates.

## M0: Foundation and Contract Freeze

Owner: Backend; Frontend reviewed contracts. Dependencies: none. Status: **implemented and locally verified.**

- [x] **F1 - Scaffold:** strict TypeScript project references across `apps/web`, `apps/server`, `packages/contracts`, `packages/db`; pinned dependencies and a committed lockfile. HTTP (`apps/server/src/http/`) and worker (`apps/server/src/jobs/`) are separate entry points, and importing the HTTP app starts no scheduler or timer. Local scripts, Vite `/api` and `/health` proxying, and `vercel.json` static/API routing are in place. *Verified: clean `rm -rf node_modules && npm ci` followed by a clean build passes.* Vercel routing is configured but **not deployment-tested** (R5).
- [x] **F2 - Configuration:** `loadHttpConfig`, `loadWorkerConfig` and `loadMigrationConfig` validate each entry point separately and report only missing names, never values. `loadLocalEnvFile` explicitly loads the gitignored root `.env` for local server and worker commands; `apps/web/vite.config.ts` sets `envDir` to the repository root so the browser build reads the same file. `.env.example` holds placeholders only, and README documents every mapping. `npm run db:check-roles` performs redacted privilege checks. *A live check against the running build caught the browser bundle shipping without its public configuration; fixed by `envDir` and now asserted by the end-to-end test.*
- [x] **F3 - Shared contracts:** `packages/contracts` defines request/response/error schemas, consistent snapshots, message pagination, processing states, the five model operations, idempotency semantics, decimal-string bigint versions and cursors, deleted-event history, action state, unknown coverage and day-path payloads. Frontend reviewed them before freeze; see Contract Review Outcomes below.
- [x] **F4 - Database:** architecture sections 6-7 as two versioned migrations. `0000_init.sql` creates all sixteen tables with same-trip composite foreign keys, uniqueness, partial indexes, revisions and the private operational tables. `0001_security.sql` enables RLS everywhere, revokes the browser default grants Supabase applies, grants `authenticated` SELECT on only `trip` and `message` under membership policies, creates the `trip_api` and `trip_worker` group roles with scoped grants, and publishes exactly two tables to `supabase_realtime`. Migration credentials are separate (`MIGRATION_DATABASE_URL`) and no owner credential appears in runtime configuration. *Verified against a real PostgreSQL 17 with the `anon` and `authenticated` roles and the publication pre-created, so the migration takes the same branches it takes on Supabase.* **Not yet applied to the hosted project** - see Blockers.
- [x] **F5 - Identity and mutation foundation:** anonymous-session verification through Supabase Auth (a real network verification, never a local decode), atomic trip create/join/invite handling, membership checks, self-only permissions, RLS, the intended realtime publication, command receipts, durable rate-limit counters, trip-first locking, and message id allocation after the trip lock. Authentication happens in an `onRequest` hook, outside every transaction. Endpoints implemented: `POST /api/trips`, `POST /api/invites/preview`, `POST /api/trips/join`, `POST /api/trips/:id/invites`, `GET /api/trips/:id/snapshot`, `GET /api/trips/:id/processing`, `GET|POST /api/trips/:id/messages`, `PATCH /api/trips/:id/people/me`, `PATCH /api/trips/:id`, `GET /health/live`, `GET /health/ready`. Event, attendance, place, action, export and process endpoints belong to M1-M4.
- [x] **F6 - Verification harness:** `scripts/verify.sh` runs formatting, lint, strict typecheck, unit tests, real-Postgres integration tests and the production build, and reports a check it cannot run as a failure rather than a pass. Vitest projects separate unit from integration; `scripts/test-db.sh` starts a disposable local cluster; the integration harness refuses any Supabase host outright. Playwright is configured and its smoke test passes against the built bundle.

### M0 exit gate evidence

| Gate requirement | Evidence |
| --- | --- |
| Fresh install and build succeed | `rm -rf node_modules && npm ci`, then a clean build: `./scripts/verify.sh` reports `PASS: 6/6 checks`. |
| Anonymous create and join work | Two independent anonymous sessions obtained from the live Supabase project created a trip, previewed the invite, joined with palette index 1, sent a message and read a consistent snapshot through the running API. |
| Isolation | `tests/integration/foundation.test.ts`: a nonmember gets 404 on snapshot, messages and sends; a member of one trip cannot read or edit another; an unknown trip id is 404, not 403. |
| Denied browser writes | `tests/integration/security.test.ts` switches to the `authenticated` role with a verified subject GUC and proves UPDATE, DELETE and INSERT are all denied on `trip` and `message`, that all fourteen other tables are unreadable, and that `anon` has no access at all. |
| Self-only edits | `tests/integration/receipts.test.ts` proves a member's edit changes only their own budget row, and that a cross-trip self-edit is 404. |
| Receipt replay | Retried, concurrent and differing-payload cases: one trip row, an identical replayed response including the issued invite token, and `IDEMPOTENCY_KEY_CONFLICT` on key reuse with different input. A replay is served even when the expected version has since gone stale. |
| Ordered concurrent messages | `tests/integration/messages.test.ts` holds the trip lock in one transaction, proves a second writer blocks on it, and proves the id allocated after the lock is strictly higher. Ten concurrent sends produce ten distinct, ordered ids. |
| RLS and publication behavior tested | RLS is asserted enabled on every table, security-definer functions are asserted to pin `search_path` and to be non-executable by `public`, and the publication is asserted to contain exactly `message` and `trip`. |
| Restricted-role connectivity tested | **Not met.** Grants are asserted in tests against the group roles, but no login role exists on the hosted project; `DATABASE_URL` currently bypasses RLS. See Blockers. |
| Contracts reviewed | Frontend review completed; all blocking findings fixed before freeze. |
| README explains commands and prerequisites | README covers layout, per-consumer configuration, migrations, runtime roles, local commands, verification and the integration-test prerequisites. |

Totals: 44 unit tests, 50 real-database integration tests, 1 end-to-end test, all passing.

### Contract Review Outcomes

Frontend reviewed the frozen contracts against M1 P1-P5 and M3 G3-G4. Blocking findings, all fixed:

- **Realtime payloads had no contract.** The browser subscribes to raw `trip` and `message` rows, and `@supabase/realtime-js` converts `int8` with `Number()`, so `calendar_version` and message ids arrive as JavaScript numbers, contradicting the decimal-string rule in architecture section 6. Added `realtimeTripRow` and `realtimeMessageRow`, which coerce those columns back to decimal strings and document that raw rows use column names, not resource names.
- **Decimal-string versions had no comparator.** `'9' > '10'` is true for strings, and a trip passes version 10 within a minute. Added `compareVersions` and `isNewerVersion`, which every version-monotonic cache update in P4 must use.
- **`tripResource` exposed no creator identity**, so the invite UI could not tell who may rotate a link without provoking a 403. Added server-resolved `creator_person_id`; the creator's auth user id stays private.

Also applied: `available_choices` on stored actions so the client never hardcodes the type-to-choice mapping; a single colour source on day-path nodes and edges (`color_indexes` removed, colours come from `members[].color`) so calendar and map cannot diverge; documented unknown-coverage semantics so a venue-less event is never reported as unresolved; documented the budget subtotal invariant and that seeded prices join confirmed; required one `dayPathResource` per trip date and deterministic path node and edge ids; renamed `last_processed_msg_id` to `last_processed_message_id`; typed every web client request body and surfaced response-contract mismatches in development.

Open questions the frontend raised that M1 must settle, not contract defects: whether `snapshot.actions` carries resolved actions or only pending ones (documented as pending plus a bounded resolved tail, to be implemented in M2); and that an invite token is shown once and never recoverable, so the client must persist it or its idempotency key rather than minting a new link on every share.

### Deliberate M0 scope boundaries

- `GET /api/trips/:id/processing` is an addition to the endpoints listed in architecture section 12, justified by section 11's requirement to poll processing availability even while realtime is connected: a stopped worker changes no database row, so no change event can ever report it. Frontend confirmed the shape and the need.
- The snapshot returns schema-valid but empty `events`, `attendance`, `places`, `warnings`, `day_paths`, `actions` and `recent_deletions`. Those projections are filled by M1 and M3 from the same consistent repeatable-read transaction. The budget rows are present with zero spend because no event exists yet. This is a milestone boundary, not a stub to be forgotten.
- A join writes a system audit message and bumps the calendar version; chat inserts deliberately do not.

## M1: Manual Planner Vertical Slice

Owners: Backend and Frontend in parallel after F3-F5. Dependencies: M0 foundation.

- [ ] **P1 - Onboarding and chat:** build real empty-trip creation, invite preview/join/share, session persistence, and two-browser chat. Enforce one destination/zone, USD, one to seven inclusive dates, 12 members, immutable person colors, and architecture capacity limits. Support manual destination center/timezone when place search is disabled.
- [ ] **P2 - Manual commands:** implement event add/edit/delete/restore, own in/out/undecided attendance, own budget/name, shared names, manual venue coordinates/hours, and paginated deletion history. Manual creation opts its actor in; human time edits lock scheduling. Commands use canonical responses, receipts, version checks, and atomic audit effects.
- [ ] **P3 - Deterministic domain:** implement integer-money budgets with unknown coverage, half-open conflicts, global maximum-three overlap enforcement, timezone/DST validation, straight-line travel estimates, stored exact-date opening-hours checks, final-state zero-attendance deletion, and deduplicated warning transitions. HTTP and future batch operations use these same services.
- [ ] **P4 - Authoritative snapshots/realtime:** consistent snapshot reads; bounded before/after message pagination; notification buffering, nonce reconciliation, version-monotonic cache updates, gap/reconnect catch-up, and five-second fallback polling. Retain unsent drafts and explicitly distinguish pending/failed/saved state. Never automatically replay stale destructive edits.
- [ ] **P5 - Calendar and budget UI:** FullCalendar Standard with fixed left budget panel, stable day/event geometry, roster colors, up to three simultaneous events, all manual forms, restore history, and return to preserved chat. Retain accessible controls and horizontal scrolling on narrow screens. Inspect `design/references/` as visual references, not substitutes for functional requirements.

Exit gate: two independent anonymous browser contexts can create/join, chat, edit, change their own attendance/budget, and see consistent updates with Gemini and Geoapify disabled. Cross-member/cross-trip actions fail. A stale edit retains its draft; a rejected fourth overlap preserves all prior state. Known zero and unknown price/location/hours render differently. Refresh and realtime interruption recover without duplication.

## M2: Durable Gemini Extraction

Owner: Backend; Frontend owns processing/action presentation. Dependencies: M1 mutation invariants; evaluation fixtures may start after F3.

- [ ] **L1 - Provider preflight and evaluations:** verify `gemini-3.5-flash-lite` against the supplied project, exported structured-output schema, timeout/output budget, and actual quotas. If unavailable or incompatible, report the exact issue to Kartik; do not silently choose another model. Version prompt/schema/model metadata. Build recorded fixtures with expected semantic outcomes; keep live provider smoke tests separate from deterministic CI.
- [ ] **L2 - Durable scheduler:** implement database-backed count/inactivity/manual triggers, fixed batch ranges, bounded context/replies, lease tokens and renewal, attempt state, retries, worker heartbeat/revision compatibility, provider admission counters, and graceful shutdown. Normal threshold/inactivity: 10 messages / 15 minutes; demo: 3 / 20 seconds; poll every two seconds. Other bounds follow architecture section 8 without locally invented alternatives.
- [ ] **L3 - Extraction validation:** official stateless, non-streaming Gemini adapter; no model tools or search grounding. Validate envelope, references, authored consent, current-batch trigger, human precedence, day/time interpretation, duplicate/tombstone matches, and all five operations. Malformed/refused/truncated output fails the attempt, not an empty successful batch. Disable SDK retry multiplication.
- [ ] **L4 - Atomic application:** stale-version re-extraction, ownership-fenced commits, per-operation savepoints for expected rejection only, atomic create/roster and reschedule, and one transaction for effects/audit/actions/warnings/watermark. Preserve original event IDs and rosters on moves. Implement revival, revision-bound Undo, and one-shot Remove/Keep through shared mutation rules.
- [ ] **L5 - Processing UI:** Update plan queues durable work and returns promptly. Show queued/running/retry/failed/unavailable states, manual Retry, and stored action buttons. Poll processing availability even when realtime is connected; a stopped worker cannot appear healthy indefinitely. Chat/manual planning remain usable throughout.

Exit gate: count, idle, and manual processing work while all browsers are closed. Restart resumes pending work. Lease A expires, B commits, and late A cannot commit or clear B's lease. Human edits during extraction survive; stale/failed output consumes no messages. Retry after uncertain commit does not duplicate effects. Meaningful all-invalid output records rejection/clarification, while an all-noise batch needs no provider call.

Evaluation gate: test two-person creation versus solo manual creation; ambiguous agreement; explicit replies; old proposal plus new agreement; wrong weekday; prompt injection; protected human out; newer LLM refusal/reversal; atomic move; tombstone blocking; fresh revival and stale Undo. Track false commitments, missed commitments, wrong-event assignment, duplicates, and revival errors separately. Schema-valid JSON alone is not a pass; report unresolved semantic failures before release.

## M3: Place Enrichment and Canonical Map

Owners: Backend for provider/projection; Frontend for map. Dependencies: M1 services and M2 worker foundation for async integration.

- [ ] **G1 - Place search:** server-side destination-biased Geoapify Geocoding and Place Details using the same key. Bound/cache searches, validate opaque candidate references with ten-minute expiry, require human choice for ambiguity, and support manual fallback. No arbitrary client URLs, render-time geocoding, or unapproved alternate provider.
- [ ] **G2 - Durable enrichment:** lease pending place work, perform network calls outside transactions, and fence commits with place revision/ownership. Never overwrite a human correction. Normalize exact-date hours with provenance and explicit unknown/closed states; do not invent authoritative prices, coordinates, or hours.
- [ ] **G3 - Shared projections:** derive ordered event-ID sequences and prefix-tree paths on the server. Preserve stored member colors, shared prefixes, divergent branches, reconvergence histories, opposite-direction edges, unresolved stops, and conflict annotations. Calendar and map consume the same canonical information.
- [ ] **G4 - Map UI:** Leaflet/OSM day selector, fitted known markers, shared/individual path styling, attribution, textual day plan, and return to calendar. Distinguish empty day, unresolved place, and tile outage. No fabricated route across an unresolved stop; no bulk/offline tile prefetch.

Exit gate: a human place correction wins a race with enrichment; provider failure leaves the planner usable. Projection tests cover three simultaneous branches, more than three daily paths, reconvergence, same-name/different-ID events, missing coordinates, and stable colors. Visually verify real markers/tiles and failure fallback; matching calendar/map colors are an acceptance requirement.

## M4: Integrated Release and Demo

Owners: Release coordinates; Backend/Frontend fix assigned issues; Adversary reviews independently. Dependencies: M1-M3 integrated.

- [ ] **R1 - Export:** self-only live in-attended `.ics` using the existing serializer, stable event UUIDs, revision sequences, correct UTC instants, and escaped content. Verify with an independent parser; exclude deleted/out/undecided events.
- [ ] **R2 - Reproducible demo:** explicit seed command creates a separate Pittsburgh trip with three days/four participants. Verify venue coordinates, exact-date hours, and chosen price categories against venue sources; retain URLs and checked dates. Unknown stays unknown. Include agreement, branching, overspend, double-booking, travel, revival, and LLM outage scenarios without inserting fake chat into real trips.
- [ ] **R3 - Adversarial acceptance:** exercise every gate in architecture section 14 with recorded evidence. Include direct REST/realtime isolation, cross-trip IDs, invite/token handling, capacity races, concurrent inserts, action replay, stale leases, database failures, provider ceilings, and secret/log redaction. Reviewers report reproducible findings; implementation owners fix and retest.
- [ ] **R4 - Full verification:** run `./scripts/verify.sh`, real-Postgres integration tests, and two-browser Playwright E2E. Verify fresh setup and production build. Inspect desktop UI plus narrow-screen overflow, loading/error/empty states, readable text, calendar layout, and actual map assets. No skipped or unavailable required check may be represented as passed.
- [ ] **R5 - Deployed smoke and outage drill:** deploy UI/API to Vercel, run the local worker at the same compatible source revision, and test real static/API routing, anonymous auth, RLS/realtime, interactive place search when enabled, and one bounded Gemini extraction. Stop/restart worker; disable providers separately; interrupt realtime; confirm manual planning and recovery. No migration at function startup or background timers after HTTP response.
- [ ] **R6 - Runbook and verdict:** finish README with exact local/deployed setup, migration procedure, runtime-secret placement, worker start/stop, demo settings, verification commands, seed/reset safeguards, and recovery steps. Record SHIP / DO NOT SHIP with remaining risks for Kartik's acceptance.

Release gate: all P0 checkboxes have evidence; isolation, data-loss, consent, lease, and migration failures are resolved. Remaining limitations are explicit and accepted by Kartik. Immediately before presenting, confirm fresh compatible worker heartbeat, laptop awake/online, provider budget remaining, and two-browser connectivity. A working local UI alone is not a passed deployed demo.

## Deferred Work

Do not implement these while P0 remains unfinished: MongoDB migration, Railway hosting, a second scheduler, Supabase Cron adaptation, public-launch CAPTCHA, account linking, moderation, multi-destination/currency support, global itinerary optimization, autonomous LLM tools, premium calendar plugins, an unscheduled-ideas tray, or mobile-specific redesign. Public sharing requires a separate abuse-protection review; controlled-demo deferral is not a production exemption.

## Active Work

No coding task is currently claimed.

Worktree consolidation (2026-09-12): the three parallel worktree agents (`demo/backend`, `demo/scenarios`, `demo/ui`) produced **no committed work, no working-tree changes and no stashes**; all three branches are still at `b72f500`. Their sessions have exited. Nothing was integrated because there was nothing to integrate. Worktrees and branches are retained, not deleted. Work now proceeds sequentially in the primary workspace on `demo-mvp`.

Completed this session: **M0 F1-F6** (Backend), with the F3 contract review by Frontend. Verified with `./scripts/verify.sh` (6/6), 44 unit tests, 50 real-database integration tests, 1 Playwright end-to-end test, plus a live two-session walkthrough against Supabase anonymous Auth. `package-lock.json` and the workspace directories are committed as `b72f500` ("M0") on `demo-mvp`.

Next owner: Backend and Frontend can now work in parallel on **M1**. Backend starts P2 and P3 (event and attendance mutations on the existing mutation protocol, then the deterministic domain services). Frontend starts P1 and P5 against the frozen contracts, using `apps/web/src/lib/api.ts` and `design/references/` for direction. P4 depends on the realtime row contracts and `compareVersions` added during the contract review; do not reimplement either.

Before M1 feature work, someone should close the runtime-role gap below: every isolation guarantee that RLS is meant to provide is currently defence-in-depth only, because the configured API credential bypasses it.

Adapter boundary (plan_v2 "Small Implementation Boundary"): implemented in `apps/web/src/mode.ts` and `apps/web/src/adapter/`. Mode is chosen before any backend dependency is constructed; the live adapter wraps `lib/api.ts` and starts Auth only in `start()`, the demo adapter needs no credentials and serves one namespaced simulated trip. Per-mode `capabilities` replace hardcoded controls. Verified with `./scripts/verify.sh` (6/6, 61 unit tests) and three Playwright tests, including demo startup from a bundle built with no `.env`. The demo seed is deliberately thin: DATA-1 supplies events, venues and scenarios; `requestProcessing`, places, bot actions and export report unavailable in both modes until implemented.

Demo state (plan_v2 DATA-1, part of DEMO-1): three-day Pittsburgh trip, four participants with distinct budgets and palette colours, four venues with Wikipedia-sourced coordinates (checked 2026-09-12) and deliberately unknown hours. Seven named deterministic scenarios in `apps/web/src/adapter/demo/scenarios.ts`, matched on keywords over the chat transcript, each applying once; unmatched input gets an explicit clarification rather than an invented plan. Budgets, unknown coverage, day paths and all five warning kinds are derived per read. Verified with `./scripts/verify.sh` (6/6, 77 unit tests), three Playwright tests, and a browser walkthrough of the full scenario sequence. Not yet built: stored bot actions (Remove/Keep, revival/Undo), `.ics` export, place search, and the planner UI itself.

When claimed, record: task ID, owner, scope, dependencies, status, verification evidence, and next handoff. Keep unfinished checkboxes open.

## Blockers and Verification Debt

Needs a decision from Kartik:

- **Hosted migrations have not been applied.** The schema is verified against a local PostgreSQL 17 only. Applying `0000_init.sql` and `0001_security.sql` to the Supabase project is a deliberate, hard-to-reverse step, and nobody has confirmed which project is intended or whether it already holds data. It also needs `MIGRATION_DATABASE_URL`, which is not in `.env` today. Confirm the target project, then run `npm run db:migrate`.
- **Restricted runtime roles do not exist yet.** `npm run db:check-roles` reports that `DATABASE_URL` and `DATABASE_URL_WORKER` both resolve to `postgres` with `bypassrls=true`. Architecture section 5 requires scoped server credentials, and the M0 exit gate requires restricted-role connectivity to be tested. The migration already creates the `trip_api` and `trip_worker` group roles; someone with project-owner access must create login roles with passwords, grant membership, and replace the two URLs locally and in Vercel. README has the exact SQL. Until then API authorization is the only layer actually enforcing isolation for server-side access.

Known verification debt, not blocking M1:

- Gemini model access, structured-output compatibility and quotas for `gemini-3.5-flash-lite` are unverified. This is L1 in M2 and does not block the manual planner. The worker validates the key's presence only.
- Geoapify connectivity is unverified. Places are disabled by default on the API (`PLACES_ENABLED=false`) and are M3 work.
- Vercel deployment, static/API routing and the deployed smoke test are untested (R5). `vercel.json` is written but has never been deployed.
- The snapshot's event, place, warning, path, action and deletion projections are intentionally empty at M0 and must be filled by M1 and M3 from the same consistent transaction.
- `npm audit` reports a moderate advisory against the old esbuild bundled inside `drizzle-kit`, a development-only CLI. The suggested fix downgrades `drizzle-kit` by many major versions. Accepted and recorded in README; revisit when upstream updates.
- The development machine runs Node 25.9.0, outside Node LTS. `engines` allows `>=22.12 <26`; give Vercel an LTS runtime rather than matching the local version.
- Invite tokens are returned once and stored only as hashes, and there is no endpoint to read the current invite. M1 must decide how the client retains a share link across a reload.

## Completed

- [x] Product specification and resolved architecture are present.
- [x] Postgres/Supabase, Gemini, Vercel, and local-worker demo decisions are recorded.
- [x] User reports repository/account/key provisioning complete; secrets remain local.
- [x] Ordered coding-agent handoff and acceptance gates are defined in this plan.
- [x] **M0 F1-F6 implemented and verified.** Workspace scaffold, per-entry-point configuration, frozen shared contracts, database schema with RLS and restricted role grants, the identity and mutation foundation, and a real verification harness. Evidence is recorded in the M0 exit gate table above.

Supabase anonymous Auth is confirmed working on the live project: two independent anonymous sessions created a trip, joined by invite, chatted and read consistent snapshots through the running API, and a nonmember was refused. Gemini and Geoapify connectivity remain unverified.

No milestone beyond M0 is implemented. No deployment acceptance test has passed.
