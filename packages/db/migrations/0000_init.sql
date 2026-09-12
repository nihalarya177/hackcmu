CREATE TABLE "attendance" (
	"trip_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"state" text NOT NULL,
	"set_by" text NOT NULL,
	"evidence_msg_ids" bigint[],
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_pkey" PRIMARY KEY("event_id","person_id"),
	CONSTRAINT "attendance_state_value" CHECK ("attendance"."state" in ('in','out')),
	CONSTRAINT "attendance_set_by_value" CHECK ("attendance"."set_by" in ('human','llm'))
);
--> statement-breakpoint
CREATE TABLE "batch_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"lower_exclusive_msg_id" bigint NOT NULL,
	"upper_inclusive_msg_id" bigint NOT NULL,
	"captured_calendar_version" bigint NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"model" text,
	"prompt_version" text,
	"schema_version" text,
	"output" jsonb,
	"accepted_count" smallint DEFAULT 0 NOT NULL,
	"rejections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_run_trip_range_key" UNIQUE("trip_id","lower_exclusive_msg_id","upper_inclusive_msg_id"),
	CONSTRAINT "batch_run_status_value" CHECK ("batch_run"."status" in ('queued','running','retry_wait','failed','committed')),
	CONSTRAINT "batch_run_range_ordered" CHECK ("batch_run"."upper_inclusive_msg_id" > "batch_run"."lower_exclusive_msg_id"),
	CONSTRAINT "batch_run_lease_pairing" CHECK (("batch_run"."lease_token" is null) = ("batch_run"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "bot_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"source_msg_id" bigint NOT NULL,
	"batch_id" uuid,
	"type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"target_event_id" uuid,
	"target_tombstone_id" uuid,
	"expected_event_revision" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"undo_snapshot" jsonb,
	"resolved_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "bot_action_trip_id_key" UNIQUE("trip_id","id"),
	CONSTRAINT "bot_action_trip_dedupe_key" UNIQUE("trip_id","dedupe_key"),
	CONSTRAINT "bot_action_type_value" CHECK ("bot_action"."type" in ('remove_suggestion','revival_undo')),
	CONSTRAINT "bot_action_status_value" CHECK ("bot_action"."status" in ('pending','applied','dismissed','stale'))
);
--> statement-breakpoint
CREATE TABLE "command_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" uuid NOT NULL,
	"trip_id" uuid,
	"command" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" "bytea" NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_receipt_user_command_key" UNIQUE("auth_user_id","command","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"place_id" uuid,
	"label" text NOT NULL,
	"normalized_label" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"local_date" date NOT NULL,
	"start_minute" smallint NOT NULL,
	"end_minute" smallint NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"price_cents" integer,
	"price_source" text,
	"created_by" text NOT NULL,
	"created_by_person_id" uuid,
	"creation_batch_id" uuid,
	"creation_op_index" smallint,
	"creation_source_msg_id" bigint,
	"schedule_locked_by_human" boolean DEFAULT false NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_reason" text,
	"deleted_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_trip_id_key" UNIQUE("trip_id","id"),
	CONSTRAINT "event_start_range" CHECK ("event"."start_minute" between 0 and 1439),
	CONSTRAINT "event_end_range" CHECK ("event"."end_minute" between 1 and 1440),
	CONSTRAINT "event_interval_ordered" CHECK ("event"."start_minute" < "event"."end_minute"),
	CONSTRAINT "event_instants_ordered" CHECK ("event"."starts_at" < "event"."ends_at"),
	CONSTRAINT "event_price_pairing" CHECK (("event"."price_cents" is null) = ("event"."price_source" is null)),
	CONSTRAINT "event_price_range" CHECK ("event"."price_cents" is null or "event"."price_cents" between 0 and 100000000),
	CONSTRAINT "event_price_source_value" CHECK ("event"."price_source" is null or "event"."price_source" in ('seeded','estimate','confirmed')),
	CONSTRAINT "event_created_by_value" CHECK ("event"."created_by" in ('human','llm')),
	CONSTRAINT "event_deletion_pairing" CHECK (("event"."deleted_at" is null) = ("event"."deleted_reason" is null)),
	CONSTRAINT "event_deletion_reason_value" CHECK ("event"."deleted_reason" is null or "event"."deleted_reason" in ('human','auto_zero_attendance'))
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "message_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"trip_id" uuid NOT NULL,
	"author_person_id" uuid,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb,
	"reply_to_msg_id" bigint,
	"referenced_event_id" uuid,
	"client_nonce" uuid,
	"batch_id" uuid,
	"notice_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_trip_id_key" UNIQUE("trip_id","id"),
	CONSTRAINT "message_kind_value" CHECK ("message"."kind" in ('user','bot','system')),
	CONSTRAINT "message_author_matches_kind" CHECK (("message"."kind" = 'user') = ("message"."author_person_id" is not null)),
	CONSTRAINT "message_nonce_user_only" CHECK ("message"."client_nonce" is null or "message"."kind" = 'user')
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"auth_user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"color_index" smallint NOT NULL,
	"budget_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_trip_id_key" UNIQUE("trip_id","id"),
	CONSTRAINT "person_trip_auth_user_key" UNIQUE("trip_id","auth_user_id"),
	CONSTRAINT "person_trip_color_key" UNIQUE("trip_id","color_index"),
	CONSTRAINT "person_color_range" CHECK ("person"."color_index" between 0 and 11),
	CONSTRAINT "person_budget_range" CHECK ("person"."budget_cents" between 0 and 100000000)
);
--> statement-breakpoint
CREATE TABLE "place" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"label" text NOT NULL,
	"normalized_label" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"provider_place_id" text,
	"address" text,
	"lat" double precision,
	"lon" double precision,
	"resolution" text DEFAULT 'pending' NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"hours_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hours_provenance" text,
	"hours_source_raw" text,
	"hours_observed_at" timestamp with time zone,
	"human_override" boolean DEFAULT false NOT NULL,
	"seed_price_cents" integer,
	"seed_price_source" text,
	"search_query" text,
	"enrichment_due_at" timestamp with time zone,
	"enrichment_lease_token" uuid,
	"enrichment_lease_expires_at" timestamp with time zone,
	"enrichment_attempts" smallint DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_trip_id_key" UNIQUE("trip_id","id"),
	CONSTRAINT "place_coordinate_pairing" CHECK (("place"."lat" is null) = ("place"."lon" is null)),
	CONSTRAINT "place_lat_range" CHECK ("place"."lat" is null or "place"."lat" between -90 and 90),
	CONSTRAINT "place_lon_range" CHECK ("place"."lon" is null or "place"."lon" between -180 and 180),
	CONSTRAINT "place_resolution_state" CHECK ("place"."resolution" in ('pending','resolved','ambiguous','unresolved','manual')),
	CONSTRAINT "place_hours_provenance" CHECK ("place"."hours_provenance" is null or "place"."hours_provenance" in ('provider','seed','human')),
	CONSTRAINT "place_seed_price_pairing" CHECK (("place"."seed_price_cents" is null) = ("place"."seed_price_source" is null))
);
--> statement-breakpoint
CREATE TABLE "place_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" uuid NOT NULL,
	"trip_id" uuid,
	"query" text NOT NULL,
	"label" text NOT NULL,
	"address" text,
	"lat" double precision,
	"lon" double precision,
	"timezone" text,
	"provider_place_id" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "place_candidate_coordinate_pairing" CHECK (("place_candidate"."lat" is null) = ("place_candidate"."lon" is null))
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"provider" text NOT NULL,
	"usage_date" date NOT NULL,
	"requests_reserved" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_usage_pkey" PRIMARY KEY("provider","usage_date")
);
--> statement-breakpoint
CREATE TABLE "request_limit" (
	"scope_hash" "bytea" NOT NULL,
	"endpoint_class" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "request_limit_pkey" PRIMARY KEY("scope_hash","endpoint_class","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "tombstone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"place_id" uuid,
	"original_label" text NOT NULL,
	"normalized_labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"deleted_by_person_id" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_by_batch_id" uuid,
	"cleared_at" timestamp with time zone,
	CONSTRAINT "tombstone_trip_id_key" UNIQUE("trip_id","id")
);
--> statement-breakpoint
CREATE TABLE "trip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_name" text NOT NULL,
	"group_name" text NOT NULL,
	"expected_headcount" smallint NOT NULL,
	"destination_label" text NOT NULL,
	"destination_lat" double precision NOT NULL,
	"destination_lon" double precision NOT NULL,
	"destination_min_lat" double precision,
	"destination_min_lon" double precision,
	"destination_max_lat" double precision,
	"destination_max_lon" double precision,
	"timezone" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"creator_auth_user_id" uuid NOT NULL,
	"calendar_version" bigint DEFAULT 0 NOT NULL,
	"last_processed_msg_id" bigint DEFAULT 0 NOT NULL,
	"last_user_msg_id" bigint DEFAULT 0 NOT NULL,
	"last_user_message_at" timestamp with time zone,
	"user_message_count" integer DEFAULT 0 NOT NULL,
	"pending_user_message_count" integer DEFAULT 0 NOT NULL,
	"next_process_at" timestamp with time zone,
	"process_requested" boolean DEFAULT false NOT NULL,
	"processing_state" text DEFAULT 'idle' NOT NULL,
	"processing_batch_id" uuid,
	"processing_attempts" smallint DEFAULT 0 NOT NULL,
	"processing_last_error_code" text,
	"processing_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_headcount_range" CHECK ("trip"."expected_headcount" between 1 and 12),
	CONSTRAINT "trip_currency_usd" CHECK ("trip"."currency" = 'USD'),
	CONSTRAINT "trip_dates_inclusive_week" CHECK ("trip"."end_date" >= "trip"."start_date" and "trip"."end_date" < "trip"."start_date" + 7),
	CONSTRAINT "trip_lat_range" CHECK ("trip"."destination_lat" between -90 and 90),
	CONSTRAINT "trip_lon_range" CHECK ("trip"."destination_lon" between -180 and 180),
	CONSTRAINT "trip_processing_state" CHECK ("trip"."processing_state" in ('idle','queued','running','retry_wait','failed','disabled')),
	CONSTRAINT "trip_lease_pairing" CHECK (("trip"."lease_token" is null) = ("trip"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "trip_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "trip_invite_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "warning" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid,
	"event_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"details" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"activated_at_version" bigint NOT NULL,
	"resolved_at_version" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warning_trip_key_key" UNIQUE("trip_id","key"),
	CONSTRAINT "warning_kind_value" CHECK ("warning"."kind" in ('double_booking','insufficient_travel_time','budget_exceeded','outside_opening_hours','venue_closed'))
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"source_revision" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_event_same_trip_fk" FOREIGN KEY ("trip_id","event_id") REFERENCES "public"."event"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_person_same_trip_fk" FOREIGN KEY ("trip_id","person_id") REFERENCES "public"."person"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_run" ADD CONSTRAINT "batch_run_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_action" ADD CONSTRAINT "bot_action_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_action" ADD CONSTRAINT "bot_action_batch_id_batch_run_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_action" ADD CONSTRAINT "bot_action_event_same_trip_fk" FOREIGN KEY ("trip_id","target_event_id") REFERENCES "public"."event"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_action" ADD CONSTRAINT "bot_action_tombstone_same_trip_fk" FOREIGN KEY ("trip_id","target_tombstone_id") REFERENCES "public"."tombstone"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_action" ADD CONSTRAINT "bot_action_resolver_same_trip_fk" FOREIGN KEY ("trip_id","resolved_by_person_id") REFERENCES "public"."person"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_receipt" ADD CONSTRAINT "command_receipt_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_place_same_trip_fk" FOREIGN KEY ("trip_id","place_id") REFERENCES "public"."place"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_creator_same_trip_fk" FOREIGN KEY ("trip_id","created_by_person_id") REFERENCES "public"."person"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_deleter_same_trip_fk" FOREIGN KEY ("trip_id","deleted_by_person_id") REFERENCES "public"."person"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_batch_id_batch_run_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_same_trip_fk" FOREIGN KEY ("trip_id","author_person_id") REFERENCES "public"."person"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_event_same_trip_fk" FOREIGN KEY ("trip_id","referenced_event_id") REFERENCES "public"."event"("trip_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_reply_same_trip_fk" FOREIGN KEY ("trip_id","reply_to_msg_id") REFERENCES "public"."message"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place" ADD CONSTRAINT "place_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_candidate" ADD CONSTRAINT "place_candidate_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tombstone" ADD CONSTRAINT "tombstone_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tombstone" ADD CONSTRAINT "tombstone_event_same_trip_fk" FOREIGN KEY ("trip_id","event_id") REFERENCES "public"."event"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tombstone" ADD CONSTRAINT "tombstone_place_same_trip_fk" FOREIGN KEY ("trip_id","place_id") REFERENCES "public"."place"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tombstone" ADD CONSTRAINT "tombstone_deleter_same_trip_fk" FOREIGN KEY ("trip_id","deleted_by_person_id") REFERENCES "public"."person"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_invite" ADD CONSTRAINT "trip_invite_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_invite" ADD CONSTRAINT "trip_invite_creator_same_trip_fk" FOREIGN KEY ("trip_id","created_by_person_id") REFERENCES "public"."person"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warning" ADD CONSTRAINT "warning_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warning" ADD CONSTRAINT "warning_person_same_trip_fk" FOREIGN KEY ("trip_id","person_id") REFERENCES "public"."person"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_trip_person_state_idx" ON "attendance" USING btree ("trip_id","person_id","state");--> statement-breakpoint
CREATE INDEX "attendance_trip_event_idx" ON "attendance" USING btree ("trip_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_run_one_active_per_trip" ON "batch_run" USING btree ("trip_id") WHERE status <> 'committed';--> statement-breakpoint
CREATE INDEX "batch_run_due_idx" ON "batch_run" USING btree ("status","next_attempt_at") WHERE status <> 'committed';--> statement-breakpoint
CREATE INDEX "bot_action_trip_pending_idx" ON "bot_action" USING btree ("trip_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "command_receipt_trip_idx" ON "command_receipt" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_batch_operation_key" ON "event" USING btree ("creation_batch_id","creation_op_index") WHERE creation_batch_id is not null;--> statement-breakpoint
CREATE INDEX "event_live_day_idx" ON "event" USING btree ("trip_id","local_date","start_minute") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "event_live_instant_idx" ON "event" USING btree ("trip_id","starts_at","ends_at") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_user_nonce_key" ON "message" USING btree ("trip_id","author_person_id","client_nonce") WHERE kind = 'user' and client_nonce is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_batch_notice_key" ON "message" USING btree ("batch_id","notice_key") WHERE batch_id is not null and notice_key is not null;--> statement-breakpoint
CREATE INDEX "message_trip_order_idx" ON "message" USING btree ("trip_id","id");--> statement-breakpoint
CREATE INDEX "message_trip_user_order_idx" ON "message" USING btree ("trip_id","id") WHERE kind = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "place_trip_search_query_key" ON "place" USING btree ("trip_id","search_query") WHERE search_query is not null;--> statement-breakpoint
CREATE INDEX "place_enrichment_due_idx" ON "place" USING btree ("enrichment_due_at") WHERE enrichment_due_at is not null;--> statement-breakpoint
CREATE INDEX "place_candidate_expiry_idx" ON "place_candidate" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "place_candidate_owner_idx" ON "place_candidate" USING btree ("auth_user_id");--> statement-breakpoint
CREATE INDEX "request_limit_expiry_idx" ON "request_limit" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tombstone_active_idx" ON "tombstone" USING btree ("trip_id","occurrence_date") WHERE cleared_at is null;--> statement-breakpoint
CREATE INDEX "trip_due_idx" ON "trip" USING btree ("next_process_at") WHERE next_process_at is not null;--> statement-breakpoint
CREATE INDEX "trip_invite_trip_idx" ON "trip_invite" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "warning_trip_active_idx" ON "warning" USING btree ("trip_id") WHERE active;