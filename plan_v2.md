# Hackathon Demo Plan

Updated: 2026-09-12. User-requested lite delivery plan after M0. Documentation only; no demo implementation is claimed complete.

## Objective and Authority

**Ship a convincing, interactive four-person trip-planning demo, not every production backend feature.** Build broad frontend coverage against contract-shaped demo data, then connect a narrow real backend workflow if time permits. A clearly labeled interactive prototype is an acceptable deliverable; a functioning live AI path is the preferred enhancement, not a prerequisite for showing the prototype.

Read `AGENTS.md`, `architecture.md`, the M0 handoff in `plan.md`, and this document before coding. `architecture.md` remains the system-behavior reference. `plan.md` retains M0 evidence and the full implementation backlog. For the user-requested demo work, this document replaces the requirement to complete every M1-M4 item before presentation. The coordinator should reference this scope from the active-work ledger in `plan.md` when assigning agents; do not mark full milestones complete because their UI is simulated.

Explicit delivery changes: introduce an isolated simulated demo adapter; prioritize all major frontend surfaces; limit the initial live extraction path to manual-triggered event creation. Deferred production features keep their existing contracts. Do not weaken authorization, persistence, or human-precedence guarantees on any path presented as live.

## Starting Point

- M0's scaffold, contracts, identity/chat APIs, migrations, and local verification are reported implemented in `plan.md`. The current web app is a foundation shell, not a planner UI.
- User reports adding `MIGRATION_DATABASE_URL` to the local `.env`. This does not establish connectivity, migration application, project confirmation, or runtime-role readiness. Never print or inspect secret values for reporting.
- M0 closure still needs confirmed hosted target/data status, reviewed migrations, restricted login roles, and actual operations tested through those roles. Check the known runtime-policy gap: table grants alone do not make an RLS-enabled table usable by non-owner roles without applicable policies.
- Existing changes across the repository belong to the implementation agents. Preserve them; do not rebuild the scaffold, rewrite migrations already applied, or clean unrelated files.
- Demo UI work can use the frozen contracts without hosted access. Hosted/live acceptance must wait for M0's outstanding gates; do not make frontend availability depend on a database connection.

## Two Explicit Modes

| Mode | Behavior | What may be claimed |
| --- | --- | --- |
| Demo | Seeded four-person state, controlled scenario transitions, local persistence, participant switching, and simulated processing. No Supabase writes or Gemini/Geoapify calls. Map tiles are optional external visual assets. | Interactive product prototype with simulated participants and AI outcomes. |
| Live | Verified Supabase identity, real API/database writes, actual sessions/realtime, and genuine worker/provider processing where implemented. | Only capabilities exercised successfully against the real services. |

Show a persistent, restrained **Demo mode** indicator in simulated sessions. A participant selector switches simulated identities, not real authenticated users. Do not claim cross-device synchronization for browser-local data. Switching mode must reset query/subscription state and enter a separate trip namespace; never move simulated state into a live trip automatically.

Live failures stay visible. Never silently replace failed provider calls or empty API results with successful fixtures. Features without live support remain visibly unavailable in live mode, with the interactive version accessible only through the separate demo experience.

## Feature Coverage

All rows below get an interactive frontend representation. Full backend parity is not the release gate. Implement the core journey first, then bounded scenarios for advanced behavior; do not spend the entire window on one sophisticated feature.

| Surface | Demo behavior | Initial live target |
| --- | --- | --- |
| Create/join/share | Wizard, sample invite flow, four named participants with distinct colors; retain the 12-member product limit. | Reuse M0 trip/invite/Auth APIs; verify separate sessions. |
| Chat | Messages, replies, pending/failed sends, four participant perspectives, system/bot notices. | Real persisted chat and reconciliation from M0 contracts. |
| AI updates | Update plan shows processing, then a scenario-backed event/action result. Include timeout/retry and a simulated count/idle-trigger scenario. | Manual Update plan only; real Gemini `create_event` proposals through a durable worker. |
| Calendar | FullCalendar Standard, three days, up to three overlapping event columns, colored rosters, preserved return to chat. | Render canonical persisted events and attendance. |
| Manual planning | Add/edit/delete/restore; own in/out/undecided; editable own budget; visible audit effects. | Add/edit/delete, own attendance/budget, and canonical snapshots first. Restore can remain demo-only. |
| Budget and conflicts | Consistent known/estimated/unknown spend; overspend and double-booking scenarios; fourth-overlap rejection. | Correct spend and overlap checks for the live slice. |
| Places, hours, travel | Curated venue choices, correction form, provenance/unknown states, known-closed and insufficient-travel-time scenarios. | Curated stored coordinates and labeled estimates; no automatic provider enrichment required. |
| Map | Actual Leaflet map, day selection, markers and attendee colors; fixture-based shared/branch paths and unresolved/tile-failure states. | Known venue markers/day list first; live path computation may come later. |
| Advanced actions | Controlled assign/deassign/move, Remove/Keep, deletion/revival/Undo and stale-action scenarios. | Deferred; do not expose working-looking buttons backed by missing endpoints. |
| Export | Download an actual `.ics` for the selected simulated person's live in-attended events using the chosen serializer. | Deferred unless the live slice is already stable. |

Use real verified coordinates for real venue markers. Label demo prices as illustrative estimates unless verified; hours without exact-date verification stay unknown outside the explicitly simulated scenario. Do not imply scripted warnings prove real-world feasibility.

## Small Implementation Boundary

- Reuse `packages/contracts`, `apps/web/src/lib/api.ts`, the existing version comparator, configuration, error shapes, and chosen libraries. Do not introduce another framework, backend service, or competing schema.
- Put one small typed adapter boundary around frontend data access, with live and demo implementations. Components must not contain scattered fake-data branches. Keep demo fixtures/scenario transitions in a dedicated web-owned module, not the production domain or database package.
- Demo startup must not require anonymous sign-in, `/health/ready`, provider keys, or a worker. Select the mode before initializing live dependencies; M0's current shell starts Auth eagerly and will need a scoped adjustment.
- Validate fixtures and adapter responses against shared schemas. Reuse pure domain calculations only where they are dependency-safe; never import database/provider modules into the browser.
- Maintain one coherent demo state for chat, events, rosters, budgets, warnings, paths, actions, revisions, and exports. Basic edits should update dependent views; unsupported combinations should return an explicit limitation, not contradictory success.
- Advanced language/action cases use named, deterministic scenario transitions and known evidence. Do not write a general NLP parser or duplicate the entire production engine for the demo. Arbitrary chat can be stored, but unmatched extraction should clarify that no scripted scenario applies.
- Persist only simulated, non-sensitive state in versioned browser-local storage. Provide a reset command that restores the demo dataset only. No backend reset endpoint, hosted database reset, or production invite/token persistence in the demo store.
- Realtime notifications are invalidation hints, not an authoritative big-integer transport. Converting an already rounded JavaScript number back to a string cannot recover precision; use canonical HTTP cursors/versions for live reconciliation when necessary. Reuse M0's comparator rather than lexical string comparison.

## Concurrent Assignments

Use three implementation workstreams at most. A fourth reviewer is optional. Assign exact files at kickoff and use separate worktrees after the coordinator has captured the intended M0 baseline; new worktrees must not accidentally start from the old docs-only commit. Never commit `.env` or credentials.

| Owner | Files / responsibilities | First deliverable |
| --- | --- | --- |
| Frontend owner | `apps/web` application shell, adapter interface/live wrapper, onboarding/chat/calendar/forms/budgets. Own web routing and shared styling. | Navigable demo with four participants and one coherent chat-to-calendar journey. |
| Demo/scenario owner | Agreed isolated demo-data/adapter directory, dedicated map component directory, and demo tests. Do not edit shared routing/styles without coordination. | Contract-valid dataset, demo adapter, scenario reset; then map/actions/export. |
| Backend/integration owner | M0 closure, server/domain/worker, database, shared contracts and root tooling; narrow real vertical slice. | Verified M0 hosted readiness, then real manual event mutation and snapshot. |
| Coordinator/reviewer | Integration, capability checklist, regression checks, deployment/rehearsal. One person or the lead agent owns progress updates. | Runnable integrated baseline and explicit Demo / Live / Pending status for each feature. |

Frontend and scenario owners agree the adapter interface immediately, then split files. Only the backend owner changes shared contracts/schema; only one agent updates root dependencies/lockfile or applies hosted migrations. Worker/provider work and manual domain work remain with the same backend owner unless clearly separable tasks emerge. Do not launch agents assigned entire M1, M2, M3, and M4 independently.

## Delivery Checkpoints

### D1: First Runnable Demo

- [ ] **UI-1:** choose explicit demo/live entry; demo works without credentials and has reset/participant controls.
- [ ] **DATA-1:** seed a three-day Pittsburgh trip with four people, distinct budgets/colors, contract-valid resources and reusable scenarios.
- [ ] **UI-2:** integrate chat, calendar, budget panel, manual event controls and navigation with the demo adapter.
- [ ] **QA-1:** rehearse agreement -> Update plan -> event -> attendance change -> budget update in one running build.

Gate: no dead primary controls, no contradictory views, no dependency on unfinished hosted services. Integrate here before implementing every advanced scenario.

### D2: Broad Feature Demonstration

- [ ] **DEMO-1:** add pairwise group splits, overspend, overlap, unknown data, manual correction and processing failure/retry scenarios.
- [ ] **DEMO-2:** add map markers and fixture-based branches; delete/restore, Remove/Keep, revival/Undo and stale-action transitions.
- [ ] **DEMO-3:** add downloadable per-person `.ics`, scenario reset/reload, and onboarding/share demonstration.
- [ ] **QA-2:** test each scenario's expected cross-view changes and inspect actual map tiles/markers, calendar geometry and narrow-screen overflow.

Gate: every feature in the coverage table has a working demonstration or is explicitly recorded as missing. Do not spend remaining time disguising an incomplete feature; prioritize the four-person story.

### L1: Real Slice, Parallel and Best Effort

- [ ] **LIVE-1:** close hosted M0 gates with explicit project approval; test actual operations under restricted runtime roles. Existing owner URLs are not accepted as runtime readiness.
- [ ] **LIVE-2:** connect real onboarding/chat plus manual event add/edit/delete, own attendance/budget, spend/conflict checks and canonical snapshots to the same UI.
- [ ] **LIVE-3:** verify user-selected `gemini-3.5-flash-lite` access; implement manual-triggered create-only extraction with two-person authored evidence, current-batch trigger, and existing durable batch/version/lease/idempotency guarantees. No silent model substitution or raw model writes.
- [ ] **LIVE-4:** demonstrate a real agreement from independent sessions becoming a persisted event. Prefer four real participants; two sessions are the minimum concurrency test, not the product/demo member limit.

Create-only means other operation types are not executed; unsupported requests receive a bounded clarification. Retain duplicate/deletion protection, human precedence and safe retry behavior. Do not claim the live AI enhancement until this path passes. If blocked, keep delivering D1/D2; do not replace the durable live architecture with a browser timer or unawaited Vercel work.

### D3: Freeze and Rehearse

- [ ] **SHIP-1:** run the applicable verification, production build and Playwright demo flow; inspect screenshots and all presentation assets.
- [ ] **SHIP-2:** verify Vercel static routes and demo startup with no backend dependency. If live mode is offered, smoke-test its API/Auth/realtime and compatible local worker separately.
- [ ] **SHIP-3:** record the exact demo route, commands, scenarios, reset steps, current revision, known limitations and supported mode in a short runbook. Rehearse twice from reset.
- [ ] **SHIP-4:** coordinator records either **Prototype ready**, **Prototype + live slice ready**, or **Not ready**, with evidence. This is not full M1-M4 completion.

Reserve the final 60-90 minutes before presenting for integration, bug fixes and rehearsal, not new features. Reassess at each checkpoint against actual time remaining; the original 12-hour window includes sleep and is not twelve hours of supervised implementation. Unattended agents should log blockers, continue independent scoped work and avoid waiting silently on one approval. No elapsed-time estimate is a completion guarantee.

## Four-Person Presentation Story

1. Show four people planning one trip, with distinct budgets and stable colors.
2. Two agree on a museum visit; Update plan creates an event with those attendees.
3. Another pair chooses a simultaneous alternative; calendar rosters show the split.
4. A participant joins an expensive activity, exposing overspend; another joins conflicting events, exposing double-booking.
5. Correct a time or attendance choice; calendar, budget, warnings and map agree.
6. Show map branches, then a short delete/revival/Undo scenario and personal calendar export.
7. Optionally switch explicitly to a separate live trip for one genuine Gemini-backed agreement. Show failure honestly if it occurs; return explicitly to Demo mode if needed.

Participant switching in Demo mode must remain obvious. Do not claim the scenario's fabricated messages came from real users or its recorded outcomes came from a live model.

## Focused Verification and Stop Rules

- Keep existing M0 checks passing. Run `./scripts/verify.sh`; integration tests use only a disposable test database, never the shared Supabase project. Missing prerequisites are reported, not silently skipped as success.
- Add focused contract/scenario tests and a Playwright rehearsal: reset -> four-member trip -> agreement -> event -> edit/attendance -> budget/conflict -> map -> action -> export -> reload/reset. Test mode isolation and no automatic live-to-fixture fallback.
- For the live slice, additionally verify nonmember rejection, self-only edits, stale response protection, duplicate retry, lost lease/human edit during extraction, and provider failure without data loss. Tests scale with the live surface, not every deferred feature.
- Use FullCalendar, Leaflet, Lucide, Luxon and the chosen calendar serializer rather than custom replacements. Keep UI domain-appropriate and readable; inspect `design/references/` before styling. Avoid spending the window on a landing page or decorative animation.
- No production enrichment pipeline, full five-operation live engine, automatic revival, public-launch infrastructure, exhaustive map algorithm, or global scheduler redesign is required to ship this prototype.
- Freeze a working smaller demo rather than merging an unverified late feature. Record missing coverage honestly and leave the full backend backlog intact for later.

## Progress

All D1-D3 and L1 tasks are unclaimed and unchecked at creation. Only the coordinator updates this ledger and mirrors active ownership in `plan.md`.

| Task | Owner | Status | Evidence / blocker |
| --- | --- | --- | --- |
| M0 hosted closure | Backend, to confirm | Pending | Migration URL added per user; target, role-policy fix and connectivity still require verification. |
| D1 core demo | Frontend + scenario owners, to assign | Pending | Adapter agreement and first integrated build. |
| D2 feature breadth | Same owners | Pending | Starts after D1 works; isolated fixtures/map work may overlap. |
| L1 real slice | Backend, to assign | Pending | Independent enhancement; cannot block the demo adapter. |
| D3 release | Coordinator, to assign | Pending | Final mode-specific evidence and rehearsal. |
