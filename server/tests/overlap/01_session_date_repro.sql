-- 01_session_date_repro.sql
--
-- Demonstrates what 002_session_date.sql fixes, and what it does NOT.
--
-- Run against a DISPOSABLE database with 001 and 002 applied. This script
-- and 02 must run in the SAME psql session (02 reuses the helpers below).
-- See README.md in this directory.
--
-- Verified on PostgreSQL 16.15.

\set ON_ERROR_STOP on
DO $guard$
BEGIN
  IF current_database() <> 'thebook_scratch' THEN
    RAISE EXCEPTION
      'Refusing to run on %. These scripts drop indexes and constraints. Use thebook_scratch.',
      current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bookings_confirmed_artist_date') THEN
    RAISE EXCEPTION
      'This script documents the ORIGINAL single-item 002 and cannot run against the completed migration.'
      USING HINT = 'See tests/session_date_harness.sql, and README.md in this directory.';
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

-- As the harness helper, but with explicit start/end times.
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
\echo ' A - the hole 002 closes: an after-midnight second gig'
\echo '=============================================================='
DO $do$
DECLARE v record; a record; b1 uuid; b2 uuid; sd1 date; sd2 date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','A venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','A artist');

  b1 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,'2026-11-07',
          '2026-11-07 23:00 Europe/Dublin','2026-11-08 03:00 Europe/Dublin');
  b2 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,'2026-11-08',
          '2026-11-08 00:30 Europe/Dublin','2026-11-08 02:00 Europe/Dublin');

  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b1;
  SELECT session_date INTO sd1 FROM book.bookings WHERE id=b1;
  RAISE NOTICE 'A: gig 1  Sat 23:00 to Sun 03:00   event_date=2026-11-07  session_date=%', sd1;

  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b2;
    SELECT session_date INTO sd2 FROM book.bookings WHERE id=b2;
    RAISE NOTICE 'A FAIL: both confirmed (session_date=%) - artist double-booked', sd2;
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'A: gig 2  Sun 00:30 to Sun 02:00   event_date=2026-11-08  session_date=2026-11-07';
    RAISE NOTICE 'A PASS: blocked by % -- 002 closes this one', SQLERRM;
  END;
END $do$;

\echo ''
\echo '=============================================================='
\echo ' B - an overlapping pair, 002 applied, nothing else changed'
\echo '=============================================================='
DO $do$
DECLARE v record; a record; b1 uuid; b2 uuid; sd1 date; sd2 date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','B venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','B artist');

  b1 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,'2026-11-14',
          '2026-11-14 05:00 Europe/Dublin','2026-11-14 07:00 Europe/Dublin');
  b2 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,'2026-11-14',
          '2026-11-14 06:30 Europe/Dublin','2026-11-14 08:00 Europe/Dublin');

  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b1;
  SELECT session_date INTO sd1 FROM book.bookings WHERE id=b1;
  RAISE NOTICE 'B: gig 1  05:00 to 07:00   event_date=2026-11-14  session_date=%', sd1;

  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b2;
    SELECT session_date INTO sd2 FROM book.bookings WHERE id=b2;
    RAISE NOTICE 'B: both confirmed (session_date=%)', sd2;
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'B: gig 2  06:30 to 08:00   event_date=2026-11-14  session_date=2026-11-14';
    RAISE NOTICE 'B: blocked by %', SQLERRM;
    RAISE NOTICE 'B NOTE: session dates DIFFER, so the session index did NOT block this.';
    RAISE NOTICE 'B NOTE: 001 bookings_confirmed_artist_date did - both share event_date.';
    RAISE NOTICE 'B NOTE: that index MASKS the defect. Script 02 retires it, as any';
    RAISE NOTICE 'B NOTE: complete move to session_date must. Then the pair confirms.';
  END;
END $do$;
