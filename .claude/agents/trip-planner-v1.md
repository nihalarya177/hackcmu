# Group Trip Planner — Technical Specification (MVP)

**HackCMU 2026** · Tracks: Optimization, Traveling, Multiplayer, Food
**Document purpose:** input to an architect agent for stack selection, architecture, and build planning.
**Status:** design frozen for MVP. Open decisions listed in §13.

---

## 1. Product summary

A group chat where the trip itinerary builds itself.

People talk normally in a chat room. Periodically, an LLM reads the recent messages plus the
current calendar, and emits a small set of operations that update the plan — creating events,
assigning people who expressed interest, removing people who opted out. A full-screen calendar,
a live per-person budget panel, and a day-by-day map render the result.

**Problem:** Group trips collapse onto one unpaid planner. Decisions get buried in scrollback,
plans turn out to be physically impossible, and someone always ends up spending the trip doing
everyone else's activities.

**What makes it not a chat summarizer:** the system checks feasibility against the real world
(opening hours, travel time, budget), it makes decisions rather than reporting disagreement, and
it holds mutable state that people commit to.

---

## 2. MVP scope

### In scope

- Trip creation wizard + invite link
- Lightweight identity (no passwords)
- Realtime group chat
- Batched LLM extraction → calendar operations
- Full-screen calendar with per-person attendance
- Deterministic budget tracking with overspend warnings
- Deterministic conflict (double-booking) detection
- Deterministic travel-time feasibility checks
- Opening-hours checks
- Price estimates with human override
- Parallel tracks (max 3 concurrent events)
- Day-by-day map with trunk/branch track rendering
- `.ics` export of a person's own events
- Manual controls for everything the LLM can't do

### Explicitly out of scope

- Real authentication (email, OAuth, passwords)
- Mobile-optimized layout — **desktop-first, deliberate choice**
- Suggested/provisional tray for low-confidence extractions
- Ticketing purchase suggestions
- Real routing APIs (haversine approximation only)
- Per-user timezones
- Trips longer than 7 days
- More than 3 concurrent events per time slot

---

## 3. Core concepts

| Term | Meaning |
|---|---|
| **Trip** | One planning session. Has dates, destination, members, an invite link. |
| **Event** | A scheduled activity: place, day, time window, price, roster. |
| **Attendance** | A person's relationship to an event: `in`, `out`, or absent (undecided). |
| **Track** | A colored path through a day, formed by which people attend which events. Not stored — derived. |
| **Batch** | One LLM run over the messages accumulated since the last run. |
| **Watermark** | The last message ID that has been *processed*. Advances once, never rewinds. |
| **Context window** | The last ~5 batches of messages, included read-only so late agreement can attach to earlier proposals. |
| **Tombstone** | A record that a human deleted an event, preventing accidental recreation. |

---

## 4. Data model

### trip
```
id                      uuid
name                    text
destination             text
start_date              date
end_date                date          -- max 7 days from start
timezone                text          -- destination timezone, single tz for whole trip
join_code               text          -- short, URL-safe
created_by              uuid
last_processed_msg_id   bigint        -- watermark
processing_lock_until   timestamptz   -- nullable, 60s advisory lock
calendar_version        int           -- optimistic concurrency
created_at              timestamptz
```

### person
```
id              uuid
trip_id         uuid
display_name    text
color           text          -- assigned from fixed palette, must be unique within trip
budget_total    numeric       -- editable by that person only
created_at      timestamptz
```

### message
```
id              bigserial     -- monotonic; ordering and watermark depend on this
trip_id         uuid
author_id       uuid          -- null for bot/system
kind            enum          -- 'user' | 'bot' | 'system'
body            text
meta            jsonb         -- nullable: action buttons, referenced event_id, etc.
created_at      timestamptz
```
**Critical:** extraction reads only `kind = 'user'`. Bot and system messages must never re-enter
the pipeline or the system will re-extract its own confirmations into duplicate events.

### place
```
id              uuid
trip_id         uuid
label           text
label_norm      text          -- lowercased, trimmed; used for dedupe and tombstone matching
lat             numeric
lng             numeric
opening_hours   jsonb         -- nullable; per-weekday open/close
seeded_price    numeric       -- nullable; from demo seed table
geocoded_at     timestamptz
```
Geocode once per unique place, cache here. Never geocode on render.

### event
```
id                  uuid
trip_id             uuid
place_id            uuid          -- nullable if place unresolved
label               text
day                 date
start_time          time
end_time            time
price_per_person    numeric       -- nullable
price_source        enum          -- 'seeded' | 'estimate' | 'confirmed'
created_by          enum          -- 'llm' | 'human'
created_at          timestamptz
deleted_at          timestamptz   -- soft delete
```

### attendance
```
event_id        uuid
person_id       uuid
state           enum          -- 'in' | 'out'
set_by          enum          -- 'llm' | 'human'
updated_at      timestamptz
PRIMARY KEY (event_id, person_id)
```
**Absence of a row = undecided.** Undecided people do not render on the calendar, do not count
toward budget, and do not trigger conflict warnings. An explicit `out` row exists so the LLM
doesn't re-assign someone who declined.

### tombstone
```
trip_id         uuid
label_norm      text
killed_by       uuid
killed_at       timestamptz
```
Written **only** on explicit human deletion. Never written by auto-delete (§7.4).
Cleared when an event of that label is legitimately revived (§6.4).

---

## 5. Processing pipeline

```
user messages accumulate
         │
    ┌────┴──────────────────────────────┐
    │  Trigger (whichever fires first)  │
    │   · 10 unprocessed user messages  │
    │   · 15 min inactivity (20s demo)  │
    │   · manual "Update plan" button   │
    └────┬──────────────────────────────┘
         │
    acquire lock (processing_lock_until = now + 60s)
         │
    ┌────┴─────────────────────────────┐
    │  Pre-filter (no LLM)             │
    │   drop: lol/haha/bare emoji/     │
    │         reactions/short chatter  │
    │   keep: 👍 👎 as signal          │
    └────┬─────────────────────────────┘
         │
    ┌────┴─────────────────────────────┐
    │  LLM call                        │
    │  IN:  current calendar JSON      │
    │       new messages (processable) │
    │       context messages (~5 batch)│
    │       tombstone list             │
    │       trip metadata + people     │
    │  OUT: operations[]               │
    └────┬─────────────────────────────┘
         │
    validate each op against schema
    apply valid ops in a transaction
    drop invalid ops, log them
         │
    run deterministic checks (§7)
         │
    post bot messages
    advance watermark, clear lock
    increment calendar_version
         │
    realtime push → calendar re-renders
```

### 5.1 Triggers

| Trigger | Production | Demo mode |
|---|---|---|
| Unprocessed user message count | 10 | 3 |
| Inactivity timer | 15 min | 20 sec |
| Manual button | instant | instant |

Thresholds must be config constants, not hardcoded.

### 5.2 Watermark and context window

This distinction matters and is easy to get wrong.

- **Processable messages:** `kind='user' AND id > last_processed_msg_id`. These are the messages
  the LLM acts on. After a successful run, the watermark advances past them. They are never
  processed again.
- **Context messages:** the previous ~5 batches' worth of user messages (cap at ~50 messages),
  included **read-only**. Their purpose is solely to let late agreement attach to an earlier
  proposal — someone proposes the museum in batch 1, someone says "I'm in" in batch 2.

**The prompt must state explicitly:** context messages may produce `assign` operations only.
They may **never** produce `create_event`. Without this rule, every batch recreates the previous
batch's events.

On failure: do not advance the watermark, clear the lock, leave the calendar untouched. Those
messages are retried on the next run.

---

## 6. LLM contract

### 6.1 Input envelope

```json
{
  "trip": {
    "destination": "New York",
    "start_date": "2026-10-02",
    "end_date": "2026-10-04",
    "timezone": "America/New_York"
  },
  "people": [
    { "id": "p1", "name": "Kartik", "budget_total": 300 },
    { "id": "p2", "name": "Ona", "budget_total": 250 }
  ],
  "calendar": [
    { "id": "evt_3", "label": "Warhol Museum", "day": "2026-10-03",
      "start": "14:00", "end": "16:00", "price_per_person": 20,
      "in": ["p1", "p2"], "out": ["p3"] }
  ],
  "rejected_labels": ["coney island"],
  "new_messages": [
    { "id": 141, "author": "p3", "name": "Nihal", "body": "can we do the high line thursday" }
  ],
  "context_messages": [
    { "id": 128, "author": "p1", "name": "Kartik", "body": "thinking high line at some point" }
  ]
}
```

### 6.2 Output operations

The LLM returns **operations, not a replacement calendar.** This is required: it survives
concurrent human edits, costs far fewer tokens, maps 1:1 to the chat audit log, and allows
partial validation.

```json
{
  "operations": [
    {
      "op": "create_event",
      "label": "The High Line",
      "day": "2026-10-03",
      "start": "10:00",
      "duration_min": 90,
      "in": ["p1", "p3"],
      "price_estimate": 0
    },
    { "op": "assign",   "event_id": "evt_3", "person_id": "p3" },
    { "op": "deassign", "event_id": "evt_3", "person_id": "p2" },
    {
      "op": "suggest_remove",
      "event_id": "evt_7",
      "reason": "Nihal said let's skip the aquarium"
    }
  ]
}
```

An empty run returns `{"operations": []}`. This should be common and cheap.

| Op | Effect |
|---|---|
| `create_event` | Inserts an event with its initial roster |
| `assign` | Sets attendance to `in` |
| `deassign` | Sets attendance to `out` |
| `suggest_remove` | **Does not modify the calendar.** Posts a bot message with Remove/Keep buttons |

The LLM has **no delete capability**. Deletion is human-only (§7.4 covers the one automatic case).

### 6.3 Event creation rule — two-person minimum

`create_event` is valid only when **at least two people** have expressed interest — one proposing
and at least one agreeing. The `in` array must contain ≥2 person IDs.

Rationale: prevents a single offhand remark from becoming a scheduled commitment.

**Known consequence:** a want held by only one person never becomes an event automatically. The
manual "add event" control is the required path for this, and is therefore not optional.

### 6.4 Tombstones and revival

`rejected_labels` is passed on every run with the instruction: do not create events matching these
labels.

**Revival is permitted** when a message in the *current* batch shows affirmative intent to do the
thing — "let's add the museum back", "actually I do want to do the museum". A revival must clear
the tombstone.

**Revival must NOT trigger on:** past-tense references, comparisons, cost complaints, or any
mention that isn't an affirmative proposal. "Glad we dropped the museum" is not a revival.
State this explicitly in the prompt with examples.

On revival, post a loud bot message: *"Re-added The Warhol Museum — this was removed earlier by
Nihal."* with an Undo button. The person who deleted it learns immediately.

### 6.5 Update semantics

**An update is a new event.** To move an event, the LLM creates the new one and deassigns everyone
from the original. The original auto-deletes at zero attendees (§7.4).

This keeps `deassign` as the LLM's only destructive verb.

### 6.6 Validation

Validate every operation before applying:
- Schema shape and required fields
- `event_id` exists and is not deleted
- `person_id` is a member of this trip
- `day` falls within trip dates
- `create_event` has ≥2 people in `in`
- `create_event` label is not in `rejected_labels` unless this batch contains a revival

Apply valid ops, drop invalid ones, log them. Never fail the whole batch for one bad op.

---

## 7. Deterministic services

**None of these involve the LLM.** All run synchronously on write and must be instant.

### 7.1 Conflict detection
On any event create/edit or attendance change, for each affected person: find overlapping events
where they are `in`. Overlap = `a.end > b.start AND b.end > a.start`.

→ Warning chip on both events + bot message: *"Nihal is double-booked — trek and museum both at 2pm."*
Resolution is manual.

### 7.2 Budget tracking
For each person: `spend = Σ price_per_person over events where state='in'`.
Compare to `budget_total`. Over → panel turns red.

Recompute on: event create/delete, price edit, attendance change, budget edit.
**Editing a budget is permitted, own budget only**, and re-runs this check immediately.

### 7.3 Travel feasibility
For each person's chronologically ordered `in` events within a day:

```python
km   = haversine(prev.lat, prev.lng, next.lat, next.lng)
need = (km / 25) * 60        # minutes, 25 km/h flat urban assumption
have = (next.start - prev.end).in_minutes()
if have < need: flag
```

→ Bot message: *"Tight — the trek is 12 km from the museum, about 30 min. You've only got 15."*

No routing API. Haversine only. This is the Traveling track claim and must work.

### 7.4 Auto-delete at zero attendance
When the last `in` attendee is removed from an event, soft-delete the event.

**This must NOT write a tombstone.** The event was emptied, not rejected — writing a tombstone
would make an accidental deassignment permanently unrecoverable.

### 7.5 Opening hours
If a proposed event's time window falls outside the place's opening hours, post a bot message
naming the actual hours. Do not block creation — inform and let humans adjust.

---

## 8. UI surfaces

### 8.1 Onboarding wizard (creator)
Group name → trip name → destination → **start and end dates** → own budget → expected headcount
→ generates invite link.

### 8.2 Join flow (invitee)
Open link → enter display name → enter own budget → assigned a color from a fixed palette
(auto-assigned; never user-chosen, to guarantee distinctness) → lands in chat.

Identity persists via `localStorage` keyed to trip ID. No passwords.

### 8.3 Chat room
Realtime. Messages render differently by `kind` — user messages plain, bot/system messages
visually distinct (tint or icon). Bot messages may carry action buttons (Remove/Keep, Undo).

A **"Update plan"** button sits next to the composer.
A small "updating plan…" indicator appears while a batch runs. The chat never blocks.

### 8.4 Calendar
Opens full-screen from a **View Calendar** button, as a floating panel over the chat with a smooth
return path.

- Day columns derived from trip dates
- Scrolls both horizontally (days) and vertically (time)
- Each event shows its roster as small filled circles in each person's color
- **Undecided people do not appear at all**
- Up to 3 concurrent events render side by side in a slot
- Manual controls per event: edit start/end, rename, edit price, delete, add/remove self

Manual edits are logged and posted to chat as system messages.

### 8.5 Budget panel
Fixed to the **left of the calendar**. Per person: committed spend vs. budget, with a bar.
Over budget → red. Own budget is editable inline. Fully deterministic, updates instantly.

### 8.6 Map
One day at a time, day/date selector on the left, smooth return to calendar.

**Track rendering — trunk and branch:**
Within a day, compute each track's event sequence. Draw the **longest common prefix once** as a
shared trunk, then branch at the first divergence.

```
red:    museum → trek → club
yellow: museum → trek → dinner

renders as:  museum → trek ─┬─→ club     (red)
                            └─→ dinner   (yellow)
```

**Track colors originate in the calendar and are stored, not recomputed by the map.** The two
views must never disagree about color — that's the entire value of the coding.

A "shared" event means the same event row, not two events with the same label. Two separate
same-name events are two tracks from the start.

Suggested implementation: Leaflet + OpenStreetMap tiles. Coordinates already exist from §7.3.

### 8.7 Export
Per-person `.ics` download of events where they are `in`.

---

## 9. Bot message catalog

| Situation | Message |
|---|---|
| Event created | "Added: The High Line, Fri 10am — Kartik, Nihal" |
| Closed at that time | "The Warhol closes at 5pm on Tuesdays." |
| Travel infeasible | "Tight — the trek is 12 km from the museum, ~30 min. You've only got 15." |
| Double-booked | "Nihal is double-booked — trek and museum both at 2pm." |
| Suggest removal | "Sounds like the aquarium is off? [Remove] [Keep]" |
| Revival | "Re-added The Warhol Museum — removed earlier by Nihal. [Undo]" |
| Auto-deleted | "Removed the aquarium — nobody's going." |
| Manual edit | "Ona moved dinner to 8pm." |

---

## 10. Failure handling

| Failure | Behavior |
|---|---|
| LLM returns malformed JSON | Validate per-op; apply valid, drop invalid, log. Never crash the panel. |
| LLM timeout / API error | Don't advance watermark, clear lock, show nothing. Retry next trigger. |
| Two triggers fire concurrently | `processing_lock_until` prevents overlap; second run skips. |
| Human edit races an LLM batch | Ops apply to current state; `calendar_version` guards. No stomping. |
| Complete LLM outage | **All manual controls, budget, conflict, travel checks, calendar, and map continue working.** This path must be demoable with the LLM disconnected. |

---

## 11. Concurrency notes for the architect

- `message.id` must be monotonic — the watermark depends on it
- Advisory lock is a timestamp column, not a distributed lock; sufficient at this scale
- Ops apply inside a transaction; skip ops referencing deleted events
- `calendar_version` increments per successful batch; realtime clients re-fetch on change
- Realtime fan-out needed for: new messages, calendar changes, budget changes

---

## 12. Build order

**Phase 0 — schema (do before any feature code)**
Trip dates, `message.kind`, watermark + lock, attendance three-state, tombstone table.
These are painful to retrofit.

**Phase 1 — skeleton**
Wizard → join link → identity → realtime chat → empty calendar panel.

**Phase 2 — the loop**
Pre-filter → LLM call → op validation → apply → bot message → calendar renders.
*This is the highest-risk component. Start the extraction prompt early; expect to iterate on it.*

**Phase 3 — deterministic layer**
Budget panel, conflict detection, travel feasibility, opening hours, auto-delete.
All cheap, all high-visibility, none dependent on the LLM behaving.

**Phase 4 — parallel tracks + map**
Track derivation, colors, trunk/branch rendering, day selector.

**Phase 5 — polish**
`.ics` export, demo-mode timers, seeded price table, seeded demo trip.

---

## 13. Open decisions for the architect

1. **Stack.** Needs realtime chat + DB + subscriptions with minimal backend. Supabase and Firebase
   are the obvious candidates. Decide first — everything depends on it.
2. **Where the batch trigger runs.** Client-side timer, server cron, or DB trigger. Affects
   reliability of the inactivity trigger when all clients are closed.
3. **Geocoding provider.** Google Places (better hours data, costs money) vs. Nominatim (free,
   rate-limited, weaker hours). Hours data quality directly affects §7.5.
4. **Unscheduled ideas.** Currently, a want that can't be scheduled ("sushi at some point,"
   no day given) is consumed and lost forever. An `unscheduled[]` array carried in the calendar
   JSON would preserve these cheaply. **Not adopted — flagged for decision.**
5. **Cold start.** First user opens an empty room and an empty calendar. Needs either seeded
   prompts, an example, or a designed empty state. Currently undefined.
6. **Demo seed data.** A fixed trip with real places, real hours, and real prices for the target
   destination — so the on-stage numbers are correct rather than estimated.