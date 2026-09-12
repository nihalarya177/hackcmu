import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Physical schema for architecture sections 6 and 7.
 *
 * Conventions enforced here rather than in application code:
 * - every child row carries trip_id and is bound to its parent by a composite
 *   (trip_id, id) foreign key, so a cross-trip reference cannot be written even
 *   by a bug in the domain layer;
 * - money is integer cents, coordinates are both-or-neither, and price value
 *   and provenance move together;
 * - soft deletion everywhere that history matters, so realtime never has to
 *   publish a physical delete.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const utc = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bigintCol = (name: string) => bigint(name, { mode: 'bigint' });

const MAX_CENTS = 100_000_000;

export const trip = pgTable(
  'trip',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripName: text('trip_name').notNull(),
    groupName: text('group_name').notNull(),
    expectedHeadcount: smallint('expected_headcount').notNull(),

    destinationLabel: text('destination_label').notNull(),
    destinationLat: doublePrecision('destination_lat').notNull(),
    destinationLon: doublePrecision('destination_lon').notNull(),
    destinationMinLat: doublePrecision('destination_min_lat'),
    destinationMinLon: doublePrecision('destination_min_lon'),
    destinationMaxLat: doublePrecision('destination_max_lat'),
    destinationMaxLon: doublePrecision('destination_max_lon'),

    timezone: text('timezone').notNull(),
    currency: text('currency').notNull().default('USD'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),

    creatorAuthUserId: uuid('creator_auth_user_id').notNull(),

    /** Bumped once per material domain change. Chat inserts never touch it. */
    calendarVersion: bigintCol('calendar_version')
      .notNull()
      .default(sql`0`),

    /** Extraction watermark: the highest user message already consumed. */
    lastProcessedMsgId: bigintCol('last_processed_msg_id')
      .notNull()
      .default(sql`0`),
    lastUserMsgId: bigintCol('last_user_msg_id')
      .notNull()
      .default(sql`0`),
    lastUserMessageAt: utc('last_user_message_at'),
    userMessageCount: integer('user_message_count').notNull().default(0),
    pendingUserMessageCount: integer('pending_user_message_count').notNull().default(0),

    nextProcessAt: utc('next_process_at'),
    processRequested: boolean('process_requested').notNull().default(false),
    processingState: text('processing_state').notNull().default('idle'),
    processingBatchId: uuid('processing_batch_id'),
    processingAttempts: smallint('processing_attempts').notNull().default(0),
    processingLastErrorCode: text('processing_last_error_code'),
    processingUpdatedAt: utc('processing_updated_at').notNull().defaultNow(),

    /** Currently owned processing lease. A lost owner may not clear a newer one. */
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: utc('lease_expires_at'),

    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('trip_headcount_range', sql`${t.expectedHeadcount} between 1 and 12`),
    check('trip_currency_usd', sql`${t.currency} = 'USD'`),
    check(
      'trip_dates_inclusive_week',
      sql`${t.endDate} >= ${t.startDate} and ${t.endDate} < ${t.startDate} + 7`,
    ),
    check('trip_lat_range', sql`${t.destinationLat} between -90 and 90`),
    check('trip_lon_range', sql`${t.destinationLon} between -180 and 180`),
    check(
      'trip_processing_state',
      sql`${t.processingState} in ('idle','queued','running','retry_wait','failed','disabled')`,
    ),
    check('trip_lease_pairing', sql`(${t.leaseToken} is null) = (${t.leaseExpiresAt} is null)`),
    index('trip_due_idx')
      .on(t.nextProcessAt)
      .where(sql`next_process_at is not null`),
  ],
);

export const person = pgTable(
  'person',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trip.id, { onDelete: 'cascade' }),
    /** Verified Supabase auth user. A submitted person id never authenticates. */
    authUserId: uuid('auth_user_id').notNull(),
    displayName: text('display_name').notNull(),
    /** Assigned once at join from the fixed palette. Never reassigned. */
    colorIndex: smallint('color_index').notNull(),
    budgetCents: integer('budget_cents').notNull().default(0),
    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('person_trip_id_key').on(t.tripId, t.id),
    unique('person_trip_auth_user_key').on(t.tripId, t.authUserId),
    unique('person_trip_color_key').on(t.tripId, t.colorIndex),
    check('person_color_range', sql`${t.colorIndex} between 0 and 11`),
    check('person_budget_range', sql`${t.budgetCents} between 0 and ${sql.raw(String(MAX_CENTS))}`),
  ],
);

export const tripInvite = pgTable(
  'trip_invite',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trip.id, { onDelete: 'cascade' }),
    /** Only the hash is stored. The token itself is shown to its creator once. */
    tokenHash: bytea('token_hash').notNull(),
    createdByPersonId: uuid('created_by_person_id'),
    createdAt: utc('created_at').notNull().defaultNow(),
    expiresAt: utc('expires_at'),
    revokedAt: utc('revoked_at'),
  },
  (t) => [
    unique('trip_invite_token_hash_key').on(t.tokenHash),
    foreignKey({
      name: 'trip_invite_creator_same_trip_fk',
      columns: [t.tripId, t.createdByPersonId],
      foreignColumns: [person.tripId, person.id],
    }),
    index('trip_invite_trip_idx').on(t.tripId),
  ],
);

export const place = pgTable(
  'place',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trip.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    normalizedLabel: text('normalized_label').notNull(),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    providerPlaceId: text('provider_place_id'),
    address: text('address'),
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),

    resolution: text('resolution').notNull().default('pending'),
    revision: bigintCol('revision')
      .notNull()
      .default(sql`0`),

    /** Normalized open intervals per actual trip date, with explicit provenance. */
    hoursDays: jsonb('hours_days')
      .notNull()
      .default(sql`'[]'::jsonb`),
    hoursProvenance: text('hours_provenance'),
    hoursSourceRaw: text('hours_source_raw'),
    hoursObservedAt: utc('hours_observed_at'),

    /** Set when a human corrects the place; enrichment must never overwrite it. */
    humanOverride: boolean('human_override').notNull().default(false),

    seedPriceCents: integer('seed_price_cents'),
    seedPriceSource: text('seed_price_source'),

    searchQuery: text('search_query'),
    enrichmentDueAt: utc('enrichment_due_at'),
    enrichmentLeaseToken: uuid('enrichment_lease_token'),
    enrichmentLeaseExpiresAt: utc('enrichment_lease_expires_at'),
    enrichmentAttempts: smallint('enrichment_attempts').notNull().default(0),
    fetchedAt: utc('fetched_at'),

    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('place_trip_id_key').on(t.tripId, t.id),
    check('place_coordinate_pairing', sql`(${t.lat} is null) = (${t.lon} is null)`),
    check('place_lat_range', sql`${t.lat} is null or ${t.lat} between -90 and 90`),
    check('place_lon_range', sql`${t.lon} is null or ${t.lon} between -180 and 180`),
    check(
      'place_resolution_state',
      sql`${t.resolution} in ('pending','resolved','ambiguous','unresolved','manual')`,
    ),
    check(
      'place_hours_provenance',
      sql`${t.hoursProvenance} is null or ${t.hoursProvenance} in ('provider','seed','human')`,
    ),
    check(
      'place_seed_price_pairing',
      sql`(${t.seedPriceCents} is null) = (${t.seedPriceSource} is null)`,
    ),
    /** One pending place per distinct search query per trip; reuse, never duplicate. */
    uniqueIndex('place_trip_search_query_key')
      .on(t.tripId, t.searchQuery)
      .where(sql`search_query is not null`),
    index('place_enrichment_due_idx')
      .on(t.enrichmentDueAt)
      .where(sql`enrichment_due_at is not null`),
  ],
);

export const event = pgTable(
  'event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trip.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id'),

    label: text('label').notNull(),
    normalizedLabel: text('normalized_label').notNull(),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    localDate: date('local_date').notNull(),
    startMinute: smallint('start_minute').notNull(),
    endMinute: smallint('end_minute').notNull(),
    /** Derived server-side from local fields plus the trip zone; never client-supplied. */
    startsAt: utc('starts_at').notNull(),
    endsAt: utc('ends_at').notNull(),

    priceCents: integer('price_cents'),
    priceSource: text('price_source'),

    createdBy: text('created_by').notNull(),
    createdByPersonId: uuid('created_by_person_id'),
    creationBatchId: uuid('creation_batch_id'),
    creationOpIndex: smallint('creation_op_index'),
    creationSourceMsgId: bigintCol('creation_source_msg_id'),

    /** A manual creation or human time edit pins the schedule against extraction. */
    scheduleLockedByHuman: boolean('schedule_locked_by_human').notNull().default(false),

    /** Bumped on any detail, attendance or deletion-state change. Binds Undo. */
    revision: bigintCol('revision')
      .notNull()
      .default(sql`0`),

    deletedAt: utc('deleted_at'),
    deletedReason: text('deleted_reason'),
    deletedByPersonId: uuid('deleted_by_person_id'),

    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('event_trip_id_key').on(t.tripId, t.id),
    foreignKey({
      name: 'event_place_same_trip_fk',
      columns: [t.tripId, t.placeId],
      foreignColumns: [place.tripId, place.id],
    }),
    foreignKey({
      name: 'event_creator_same_trip_fk',
      columns: [t.tripId, t.createdByPersonId],
      foreignColumns: [person.tripId, person.id],
    }),
    foreignKey({
      name: 'event_deleter_same_trip_fk',
      columns: [t.tripId, t.deletedByPersonId],
      foreignColumns: [person.tripId, person.id],
    }),
    check('event_start_range', sql`${t.startMinute} between 0 and 1439`),
    check('event_end_range', sql`${t.endMinute} between 1 and 1440`),
    check('event_interval_ordered', sql`${t.startMinute} < ${t.endMinute}`),
    check('event_instants_ordered', sql`${t.startsAt} < ${t.endsAt}`),
    check('event_price_pairing', sql`(${t.priceCents} is null) = (${t.priceSource} is null)`),
    check(
      'event_price_range',
      sql`${t.priceCents} is null or ${t.priceCents} between 0 and ${sql.raw(String(MAX_CENTS))}`,
    ),
    check(
      'event_price_source_value',
      sql`${t.priceSource} is null or ${t.priceSource} in ('seeded','estimate','confirmed')`,
    ),
    check('event_created_by_value', sql`${t.createdBy} in ('human','llm')`),
    check('event_deletion_pairing', sql`(${t.deletedAt} is null) = (${t.deletedReason} is null)`),
    check(
      'event_deletion_reason_value',
      sql`${t.deletedReason} is null or ${t.deletedReason} in ('human','auto_zero_attendance')`,
    ),
    /** One event per automatic operation slot; a retried batch cannot duplicate. */
    uniqueIndex('event_batch_operation_key')
      .on(t.creationBatchId, t.creationOpIndex)
      .where(sql`creation_batch_id is not null`),
    index('event_live_day_idx')
      .on(t.tripId, t.localDate, t.startMinute)
      .where(sql`deleted_at is null`),
    index('event_live_instant_idx')
      .on(t.tripId, t.startsAt, t.endsAt)
      .where(sql`deleted_at is null`),
  ],
);

export const attendance = pgTable(
  'attendance',
  {
    tripId: uuid('trip_id').notNull(),
    eventId: uuid('event_id').notNull(),
    personId: uuid('person_id').notNull(),
    /** Absence of the row is undecided; it is never stored as a third value. */
    state: text('state').notNull(),
    setBy: text('set_by').notNull(),
    evidenceMsgIds: bigint('evidence_msg_ids', { mode: 'bigint' }).array(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'attendance_pkey', columns: [t.eventId, t.personId] }),
    foreignKey({
      name: 'attendance_event_same_trip_fk',
      columns: [t.tripId, t.eventId],
      foreignColumns: [event.tripId, event.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'attendance_person_same_trip_fk',
      columns: [t.tripId, t.personId],
      foreignColumns: [person.tripId, person.id],
    }).onDelete('cascade'),
    check('attendance_state_value', sql`${t.state} in ('in','out')`),
    check('attendance_set_by_value', sql`${t.setBy} in ('human','llm')`),
    index('attendance_trip_person_state_idx').on(t.tripId, t.personId, t.state),
    index('attendance_trip_event_idx').on(t.tripId, t.eventId),
  ],
);

export const tombstone = pgTable(
  'tombstone',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trip.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    /** The specific occurrence removed, not the venue in general. */
    occurrenceDate: date('occurrence_date').notNull(),
    placeId: uuid('place_id'),
    originalLabel: text('original_label').notNull(),
    normalizedLabels: text('normalized_labels')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    deletedByPersonId: uuid('deleted_by_person_id'),
    deletedAt: utc('deleted_at').notNull().defaultNow(),
    clearedByBatchId: uuid('cleared_by_batch_id'),
    clearedAt: utc('cleared_at'),
  },
  (t) => [
    unique('tombstone_trip_id_key').on(t.tripId, t.id),
    foreignKey({
      name: 'tombstone_event_same_trip_fk',
      columns: [t.tripId, t.eventId],
      foreignColumns: [event.tripId, event.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'tombstone_place_same_trip_fk',
      columns: [t.tripId, t.placeId],
      foreignColumns: [place.tripId, place.id],
    }),
    foreignKey({
      name: 'tombstone_deleter_same_trip_fk',
      columns: [t.tripId, t.deletedByPersonId],
      foreignColumns: [person.tripId, person.id],
    }),
    index('tombstone_active_idx')
      .on(t.tripId, t.occurrenceDate)
      .where(sql`cleared_at is null`),
  ],
);

export const batchRun = pgTable(
  'batch_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trip.id, { onDelete: 'cascade' }),
    /** Fixed once at claim. A retry never silently narrows the range. */
    lowerExclusiveMsgId: bigintCol('lower_exclusive_msg_id').notNull(),
    upperInclusiveMsgId: bigintCol('upper_inclusive_msg_id').notNull(),
    capturedCalendarVersion: bigintCol('captured_calendar_version').notNull(),

    status: text('status').notNull().default('queued'),
    attempts: smallint('attempts').notNull().default(0),

    leaseToken: uuid('lease_token'),
    leaseExpiresAt: utc('lease_expires_at'),

    claimedAt: utc('claimed_at'),
    startedAt: utc('started_at'),
    finishedAt: utc('finished_at'),
    nextAttemptAt: utc('next_attempt_at'),

    model: text('model'),
    promptVersion: text('prompt_version'),
    schemaVersion: text('schema_version'),

    output: jsonb('output'),
    acceptedCount: smallint('accepted_count').notNull().default(0),
    rejections: jsonb('rejections')
      .notNull()
      .default(sql`'[]'::jsonb`),
    errorCode: text('error_code'),

    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('batch_run_trip_range_key').on(t.tripId, t.lowerExclusiveMsgId, t.upperInclusiveMsgId),
    check(
      'batch_run_status_value',
      sql`${t.status} in ('queued','running','retry_wait','failed','committed')`,
    ),
    check('batch_run_range_ordered', sql`${t.upperInclusiveMsgId} > ${t.lowerExclusiveMsgId}`),
    check(
      'batch_run_lease_pairing',
      sql`(${t.leaseToken} is null) = (${t.leaseExpiresAt} is null)`,
    ),
    /** At most one incomplete batch per trip. */
    uniqueIndex('batch_run_one_active_per_trip')
      .on(t.tripId)
      .where(sql`status <> 'committed'`),
    index('batch_run_due_idx')
      .on(t.status, t.nextAttemptAt)
      .where(sql`status <> 'committed'`),
  ],
);

export const commandReceipt = pgTable(
  'command_receipt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Scoped to the verified auth user, so creation works before a trip exists. */
    authUserId: uuid('auth_user_id').notNull(),
    tripId: uuid('trip_id').references(() => trip.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Reusing a key with different input is an error, not a silent replay. */
    payloadHash: bytea('payload_hash').notNull(),
    result: jsonb('result').notNull(),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('command_receipt_user_command_key').on(t.authUserId, t.command, t.idempotencyKey),
    index('command_receipt_trip_idx').on(t.tripId),
  ],
);

export const warning = pgTable(
  'warning',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trip.id, { onDelete: 'cascade' }),
    /** Stable key of type plus person plus relevant event ids. */
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    personId: uuid('person_id'),
    eventIds: uuid('event_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    details: jsonb('details').notNull(),
    active: boolean('active').notNull().default(true),
    activatedAtVersion: bigintCol('activated_at_version').notNull(),
    resolvedAtVersion: bigintCol('resolved_at_version'),
    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('warning_trip_key_key').on(t.tripId, t.key),
    foreignKey({
      name: 'warning_person_same_trip_fk',
      columns: [t.tripId, t.personId],
      foreignColumns: [person.tripId, person.id],
    }).onDelete('cascade'),
    check(
      'warning_kind_value',
      sql`${t.kind} in ('double_booking','insufficient_travel_time','budget_exceeded','outside_opening_hours','venue_closed')`,
    ),
    index('warning_trip_active_idx')
      .on(t.tripId)
      .where(sql`active`),
  ],
);

export const botAction = pgTable(
  'bot_action',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trip.id, { onDelete: 'cascade' }),
    sourceMsgId: bigintCol('source_msg_id').notNull(),
    batchId: uuid('batch_id').references(() => batchRun.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    /** Deduplicates an identical evidence-backed suggestion within a batch. */
    dedupeKey: text('dedupe_key').notNull(),
    targetEventId: uuid('target_event_id'),
    targetTombstoneId: uuid('target_tombstone_id'),
    /** A later event revision makes a replayed action stale rather than effective. */
    expectedEventRevision: bigintCol('expected_event_revision'),
    status: text('status').notNull().default('pending'),
    undoSnapshot: jsonb('undo_snapshot'),
    resolvedByPersonId: uuid('resolved_by_person_id'),
    createdAt: utc('created_at').notNull().defaultNow(),
    resolvedAt: utc('resolved_at'),
  },
  (t) => [
    unique('bot_action_trip_id_key').on(t.tripId, t.id),
    unique('bot_action_trip_dedupe_key').on(t.tripId, t.dedupeKey),
    foreignKey({
      name: 'bot_action_event_same_trip_fk',
      columns: [t.tripId, t.targetEventId],
      foreignColumns: [event.tripId, event.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'bot_action_tombstone_same_trip_fk',
      columns: [t.tripId, t.targetTombstoneId],
      foreignColumns: [tombstone.tripId, tombstone.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'bot_action_resolver_same_trip_fk',
      columns: [t.tripId, t.resolvedByPersonId],
      foreignColumns: [person.tripId, person.id],
    }),
    check('bot_action_type_value', sql`${t.type} in ('remove_suggestion','revival_undo')`),
    check('bot_action_status_value', sql`${t.status} in ('pending','applied','dismissed','stale')`),
    index('bot_action_trip_pending_idx')
      .on(t.tripId)
      .where(sql`status = 'pending'`),
  ],
);

export const message = pgTable(
  'message',
  {
    /** Allocated at insert, which always happens after the trip row lock. */
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trip.id, { onDelete: 'cascade' }),
    authorPersonId: uuid('author_person_id'),
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    metadata: jsonb('metadata'),
    replyToMsgId: bigintCol('reply_to_msg_id'),
    referencedEventId: uuid('referenced_event_id'),
    clientNonce: uuid('client_nonce'),
    batchId: uuid('batch_id').references(() => batchRun.id, { onDelete: 'set null' }),
    /** Deduplicates bot notices and warning transitions within one batch. */
    noticeKey: text('notice_key'),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('message_trip_id_key').on(t.tripId, t.id),
    foreignKey({
      name: 'message_author_same_trip_fk',
      columns: [t.tripId, t.authorPersonId],
      foreignColumns: [person.tripId, person.id],
    }),
    foreignKey({
      name: 'message_event_same_trip_fk',
      columns: [t.tripId, t.referencedEventId],
      foreignColumns: [event.tripId, event.id],
    }).onDelete('set null'),
    /** A reply target must be a message in the same trip. */
    foreignKey({
      name: 'message_reply_same_trip_fk',
      columns: [t.tripId, t.replyToMsgId],
      foreignColumns: [t.tripId, t.id],
    }),
    check('message_kind_value', sql`${t.kind} in ('user','bot','system')`),
    /** A user message always has a same-trip author; bot and system never do. */
    check(
      'message_author_matches_kind',
      sql`(${t.kind} = 'user') = (${t.authorPersonId} is not null)`,
    ),
    check('message_nonce_user_only', sql`${t.clientNonce} is null or ${t.kind} = 'user'`),
    uniqueIndex('message_user_nonce_key')
      .on(t.tripId, t.authorPersonId, t.clientNonce)
      .where(sql`kind = 'user' and client_nonce is not null`),
    uniqueIndex('message_batch_notice_key')
      .on(t.batchId, t.noticeKey)
      .where(sql`batch_id is not null and notice_key is not null`),
    index('message_trip_order_idx').on(t.tripId, t.id),
    index('message_trip_user_order_idx')
      .on(t.tripId, t.id)
      .where(sql`kind = 'user'`),
  ],
);

/**
 * Server-private operational tables. No browser role ever receives a grant on
 * any of these, and they carry no RLS policy.
 */

export const providerUsage = pgTable(
  'provider_usage',
  {
    provider: text('provider').notNull(),
    usageDate: date('usage_date').notNull(),
    /** Reserved before every outbound attempt, including retries. Never refunded. */
    requestsReserved: integer('requests_reserved').notNull().default(0),
    inputTokens: bigintCol('input_tokens')
      .notNull()
      .default(sql`0`),
    outputTokens: bigintCol('output_tokens')
      .notNull()
      .default(sql`0`),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'provider_usage_pkey', columns: [t.provider, t.usageDate] })],
);

export const workerHeartbeat = pgTable('worker_heartbeat', {
  workerId: text('worker_id').primaryKey(),
  /** Compared against the deployed API revision before work is trusted. */
  sourceRevision: text('source_revision').notNull(),
  lastSeenAt: utc('last_seen_at').notNull().defaultNow(),
  startedAt: utc('started_at').notNull().defaultNow(),
});

export const requestLimit = pgTable(
  'request_limit',
  {
    /** Hashed session or IP scope; never a raw address or token. */
    scopeHash: bytea('scope_hash').notNull(),
    endpointClass: text('endpoint_class').notNull(),
    bucketStart: utc('bucket_start').notNull(),
    count: integer('count').notNull().default(0),
    expiresAt: utc('expires_at').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'request_limit_pkey',
      columns: [t.scopeHash, t.endpointClass, t.bucketStart],
    }),
    index('request_limit_expiry_idx').on(t.expiresAt),
  ],
);

/** Short-lived server-issued place-search candidates, referenced opaquely. */
export const placeCandidate = pgTable(
  'place_candidate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authUserId: uuid('auth_user_id').notNull(),
    tripId: uuid('trip_id').references(() => trip.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    label: text('label').notNull(),
    address: text('address'),
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),
    timezone: text('timezone'),
    providerPlaceId: text('provider_place_id'),
    raw: jsonb('raw'),
    createdAt: utc('created_at').notNull().defaultNow(),
    expiresAt: utc('expires_at').notNull(),
  },
  (t) => [
    check('place_candidate_coordinate_pairing', sql`(${t.lat} is null) = (${t.lon} is null)`),
    index('place_candidate_expiry_idx').on(t.expiresAt),
    index('place_candidate_owner_idx').on(t.authUserId),
  ],
);
