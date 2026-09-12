-- Row level security, browser grants, restricted application roles and the
-- realtime publication.
--
-- Guarded so the same migration applies to hosted Supabase (where the anon and
-- authenticated roles and the supabase_realtime publication already exist) and
-- to a plain Postgres instance used for integration tests.

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint

-- Supabase's auth.uid() reads the verified JWT subject from the request GUC.
-- Reimplemented here without depending on the auth schema so the identical
-- policies can be exercised against a local test database.
CREATE OR REPLACE FUNCTION app.current_auth_uid() RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- Nonrecursive membership lookup. person carries no policy of its own, so this
-- can never re-enter RLS evaluation. Requires an authenticated subject.
CREATE OR REPLACE FUNCTION app.is_trip_member(p_trip_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT app.current_auth_uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.person p
       WHERE p.trip_id = p_trip_id
         AND p.auth_user_id = app.current_auth_uid()
     );
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.current_auth_uid() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.is_trip_member(uuid) FROM PUBLIC;
--> statement-breakpoint

-- Every exposed table gets RLS. Tables without a policy are therefore closed to
-- every non-owner role, which is the intended default.
ALTER TABLE public.trip ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.person ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.trip_invite ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.place ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.event ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.tombstone ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.batch_run ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.command_receipt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.warning ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.bot_action ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.provider_usage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.worker_heartbeat ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.request_limit ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.place_candidate ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Browser roles. Supabase grants broad default privileges on new public tables
-- to anon and authenticated, so those have to be revoked explicitly rather than
-- merely not granted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    REVOKE USAGE ON SCHEMA app FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    -- Realtime needs SELECT visibility, and nothing else, on exactly two tables.
    GRANT SELECT ON public.trip TO authenticated;
    GRANT SELECT ON public.message TO authenticated;
    GRANT USAGE ON SCHEMA app TO authenticated;
    GRANT EXECUTE ON FUNCTION app.is_trip_member(uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION app.current_auth_uid() TO authenticated;
  END IF;
END;
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'trip' AND policyname = 'trip_member_select'
    ) THEN
      CREATE POLICY trip_member_select ON public.trip
        FOR SELECT TO authenticated
        USING (app.is_trip_member(id));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'message' AND policyname = 'message_member_select'
    ) THEN
      CREATE POLICY message_member_select ON public.message
        FOR SELECT TO authenticated
        USING (app.is_trip_member(trip_id));
    END IF;
  END IF;
END;
$$;
--> statement-breakpoint

-- Restricted application group roles. These are NOLOGIN and carry no password;
-- the operator creates login roles separately and grants membership, so no
-- credential is ever written into a migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trip_api') THEN
    CREATE ROLE trip_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trip_worker') THEN
    CREATE ROLE trip_worker NOLOGIN;
  END IF;
END;
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO trip_api, trip_worker;--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO trip_api, trip_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.is_trip_member(uuid) TO trip_api, trip_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_auth_uid() TO trip_api, trip_worker;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trip_api, trip_worker;--> statement-breakpoint

-- The hosted API never claims leases, writes provider usage, or heartbeats.
GRANT SELECT, INSERT, UPDATE ON
  public.trip, public.person, public.trip_invite, public.place, public.event,
  public.tombstone, public.warning, public.bot_action
  TO trip_api;--> statement-breakpoint
GRANT SELECT, INSERT ON public.message, public.command_receipt TO trip_api;--> statement-breakpoint
-- Undecided attendance is the absence of a row, so self-edits must delete.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance TO trip_api;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.request_limit, public.place_candidate TO trip_api;--> statement-breakpoint
GRANT SELECT ON public.batch_run, public.worker_heartbeat TO trip_api;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON
  public.trip, public.person, public.place, public.event, public.tombstone,
  public.warning, public.bot_action, public.batch_run, public.provider_usage,
  public.worker_heartbeat
  TO trip_worker;--> statement-breakpoint
GRANT SELECT, INSERT ON public.message, public.command_receipt TO trip_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance TO trip_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.request_limit, public.place_candidate TO trip_worker;--> statement-breakpoint
GRANT SELECT ON public.trip_invite TO trip_worker;--> statement-breakpoint

-- Future tables must not silently inherit broad browser privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated';
  END IF;
END;
$$;
--> statement-breakpoint

-- Publish exactly the two tables the browser is allowed to observe. Postgres
-- Changes still honours the SELECT policies above.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'trip'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.trip;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'message'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.message;
    END IF;
  END IF;
END;
$$;
