-- 03_false_rejection.sql
--
-- Standalone. Run against a FRESH disposable database with 001 and 002
-- applied and nothing else -- in particular with 001's
-- bookings_confirmed_artist_date still in place. Do not run this after 02,
-- which drops that index.
--
-- Shows the second reason that index must be retired: it refuses bookings
-- that are on different sessions and do not overlap.
--
-- Verified on PostgreSQL 16.15.

\set ON_ERROR_STOP on
DO $guard$
BEGIN
  IF current_database() <> 'thebook_scratch' THEN
    RAISE EXCEPTION 'Refusing to run on %. Use thebook_scratch.', current_database();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'bookings_confirmed_artist_date'
  ) THEN
    RAISE EXCEPTION
      'bookings_confirmed_artist_date is missing - this database has had 02 applied. Rebuild it.';
  END IF;
END $guard$;
\set ON_ERROR_STOP off

\set QUIET on
\pset format unaligned
\pset tuples_only on

CREATE OR REPLACE FUNCTION pg_temp.mkparty(kind text, nm text)
RETURNS TABLE(user_id uuid, profile_id uuid)
LANGUAGE plpgsql AS $fn$
DECLARE u uuid := gen_random_uuid(); p uuid := gen_random_uuid();
BEGIN
  INSERT INTO book.users(id,email) VALUES (u, u||'@example.invalid');
  INSERT INTO book.profiles(id,kind,name,county) VALUES (p,kind,nm,'Cork');
  IF kind='venue' THEN INSERT INTO book.venue_details(profile_id) VALUES (p);
  ELSE INSERT INTO book.artist_details(profile_id) VALUES (p); END IF;
  INSERT INTO book.profile_memberships(profile_id,user_id,role) VALUES (p,u,'owner');
  RETURN QUERY SELECT u,p;
END $fn$;

CREATE OR REPLACE FUNCTION pg_temp.mkgig(
  v_user uuid, v_prof uuid, a_prof uuid, d date, s timestamptz, e timestamptz)
RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE b uuid := gen_random_uuid();
BEGIN
  INSERT INTO book.bookings(
    id,artist_profile_id,venue_profile_id,gig_call_id,origin,event_date,
    status,terms_revision,accepted_terms_revision,created_by_user_id)
  VALUES (b,a_prof,v_prof,NULL,'venue_request',d,'accepted',1,1,v_user);
  INSERT INTO book.booking_terms(
    booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,1,s,e,50000,0,v_user);
  RETURN b;
END $fn$;

\echo ''
\echo '=============================================================='
\echo ' F - two NON-overlapping gigs on different sessions, one day'
\echo '     01:00 to 04:00 (previous session) and 21:00 to 23:00'
\echo '=============================================================='
DO $do$
DECLARE v record; a record; b1 uuid; b2 uuid; sd1 date; sd2 date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','F venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','F artist');

  b1 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,'2026-12-11',
          '2026-12-11 01:00 Europe/Dublin','2026-12-11 04:00 Europe/Dublin');
  b2 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,'2026-12-11',
          '2026-12-11 21:00 Europe/Dublin','2026-12-11 23:00 Europe/Dublin');

  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b1;
  SELECT session_date INTO sd1 FROM book.bookings WHERE id=b1;
  RAISE NOTICE 'F: gig 1  01:00 to 04:00   event_date=2026-12-11  session_date=%', sd1;

  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b2;
    SELECT session_date INTO sd2 FROM book.bookings WHERE id=b2;
    RAISE NOTICE 'F: gig 2  21:00 to 23:00   event_date=2026-12-11  session_date=%', sd2;
    RAISE NOTICE 'F: both confirmed - no false rejection';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'F: gig 2  21:00 to 23:00   event_date=2026-12-11  session_date=2026-12-11';
    RAISE NOTICE 'F FAIL: false rejection - blocked by %', SQLERRM;
    RAISE NOTICE 'F FAIL: different sessions, no overlap. An artist finishing at';
    RAISE NOTICE 'F FAIL: 04:00 cannot take that evening gig.';
  END;
END $do$;
