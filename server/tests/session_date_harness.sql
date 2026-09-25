\set ON_ERROR_STOP off
\set QUIET on
\pset format unaligned
\pset tuples_only on

-- ============================================================
-- Tests for 002_session_date.sql.
--
-- Covers the boundary cases the runbook asks for: 05:59, exactly 06:00, a
-- booking crossing the 06:00 seam, and both Dublin DST changeovers. Also
-- covers the two behaviours the migration exists to change -- after-midnight
-- double-booking is blocked, adjacent-session bookings are no longer falsely
-- rejected -- and the gig-call FK resolution.
--
-- Run against a database with 001 and 002 applied.
-- ============================================================

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

-- event_date is derived from the start here so the fixtures cannot drift from
-- guard_booking_update, which requires them to agree at confirmation.
CREATE OR REPLACE FUNCTION pg_temp.mkgig(
  v_user uuid, v_prof uuid, a_prof uuid, s timestamptz, e timestamptz,
  call_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE b uuid := gen_random_uuid(); d date;
BEGIN
  d := (s AT TIME ZONE 'Europe/Dublin')::date;
  INSERT INTO book.bookings(
    id,artist_profile_id,venue_profile_id,gig_call_id,origin,event_date,
    status,terms_revision,accepted_terms_revision,created_by_user_id)
  VALUES (b,a_prof,v_prof,call_id,
    CASE WHEN call_id IS NULL THEN 'venue_request' ELSE 'gig_application' END,
    d,'accepted',1,1,v_user);
  INSERT INTO book.booking_terms(
    booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,1,s,e,50000,0,v_user);
  RETURN b;
END $fn$;

CREATE OR REPLACE FUNCTION pg_temp.confirm(b uuid) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b;
END $fn$;

\echo '=== S1: 05:59 start, ending exactly at 06:00 ==='
DO $do$
DECLARE v record; a record; b uuid; sd date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S1 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S1 artist');
  b := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
        '2026-11-14 05:59 Europe/Dublin','2026-11-14 06:00 Europe/Dublin');
  PERFORM pg_temp.confirm(b);
  SELECT session_date INTO sd FROM book.bookings WHERE id=b;
  IF sd = DATE '2026-11-13' THEN
    RAISE NOTICE 'S1 PASS: 05:59 belongs to session %, and ending exactly at 06:00 is allowed', sd;
  ELSE
    RAISE NOTICE 'S1 FAIL: expected session 2026-11-13, got %', sd;
  END IF;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'S1 FAIL: rejected although it ends exactly on the boundary: %', SQLERRM;
END $do$;

\echo '=== S2: 06:00 start belongs to that day, not the night before ==='
DO $do$
DECLARE v record; a record; b uuid; sd date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S2 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S2 artist');
  b := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
        '2026-11-14 06:00 Europe/Dublin','2026-11-14 08:00 Europe/Dublin');
  PERFORM pg_temp.confirm(b);
  SELECT session_date INTO sd FROM book.bookings WHERE id=b;
  IF sd = DATE '2026-11-14' THEN
    RAISE NOTICE 'S2 PASS: 06:00 starts session % - one minute later than S1, one day later', sd;
  ELSE
    RAISE NOTICE 'S2 FAIL: expected session 2026-11-14, got %', sd;
  END IF;
END $do$;

\echo '=== S3: ending one minute past 06:00 is rejected ==='
DO $do$
DECLARE v record; a record; b uuid;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S3 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S3 artist');
  b := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
        '2026-11-14 05:00 Europe/Dublin','2026-11-14 06:01 Europe/Dublin');
  BEGIN
    PERFORM pg_temp.confirm(b);
    RAISE NOTICE 'S3 FAIL: confirmed a performance running past the boundary';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'S3 PASS: %', SQLERRM;
  END;
END $do$;

\echo '=== S4: a booking crossing the 06:00 seam is rejected ==='
DO $do$
DECLARE v record; a record; b uuid;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S4 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S4 artist');
  b := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
        '2026-11-14 05:00 Europe/Dublin','2026-11-14 07:00 Europe/Dublin');
  BEGIN
    PERFORM pg_temp.confirm(b);
    RAISE NOTICE 'S4 FAIL: confirmed 05:00-07:00, which is what allowed the overlap';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'S4 PASS: %', SQLERRM;
  END;
END $do$;

\echo '=== S5: DST spring forward, 2027-03-28 (01:00 GMT becomes 02:00 IST) ==='
DO $do$
DECLARE v record; a record; b uuid; sd date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S5 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S5 artist');
  -- Runs through the hour that does not exist locally.
  b := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
        '2027-03-27 23:00 Europe/Dublin','2027-03-28 03:00 Europe/Dublin');
  PERFORM pg_temp.confirm(b);
  SELECT session_date INTO sd FROM book.bookings WHERE id=b;
  IF sd = DATE '2027-03-27' THEN
    RAISE NOTICE 'S5 PASS: set across the spring-forward gap stays on session %', sd;
  ELSE
    RAISE NOTICE 'S5 FAIL: expected session 2027-03-27, got %', sd;
  END IF;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'S5 FAIL: rejected across the DST gap: %', SQLERRM;
END $do$;

\echo '=== S6: DST fall back, 2026-10-25 (02:00 IST becomes 01:00 GMT) ==='
DO $do$
DECLARE v record; a record; b uuid; sd date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S6 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S6 artist');
  -- Runs through the hour that happens twice locally.
  b := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
        '2026-10-24 23:00 Europe/Dublin','2026-10-25 04:00 Europe/Dublin');
  PERFORM pg_temp.confirm(b);
  SELECT session_date INTO sd FROM book.bookings WHERE id=b;
  IF sd = DATE '2026-10-24' THEN
    RAISE NOTICE 'S6 PASS: set across the repeated hour stays on session %', sd;
  ELSE
    RAISE NOTICE 'S6 FAIL: expected session 2026-10-24, got %', sd;
  END IF;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'S6 FAIL: rejected across the DST overlap: %', SQLERRM;
END $do$;

\echo '=== S7: adjacent sessions cannot overlap, and both confirm ==='
DO $do$
DECLARE v record; a record; b1 uuid; b2 uuid; sd1 date; sd2 date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S7 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S7 artist');
  b1 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
         '2026-11-20 23:00 Europe/Dublin','2026-11-21 05:59 Europe/Dublin');
  b2 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
         '2026-11-21 06:30 Europe/Dublin','2026-11-21 08:00 Europe/Dublin');
  PERFORM pg_temp.confirm(b1);
  PERFORM pg_temp.confirm(b2);
  SELECT session_date INTO sd1 FROM book.bookings WHERE id=b1;
  SELECT session_date INTO sd2 FROM book.bookings WHERE id=b2;
  RAISE NOTICE 'S7 PASS: sessions % and % both confirmed, ending 05:59 before starting 06:30', sd1, sd2;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'S7 FAIL: %', SQLERRM;
END $do$;

\echo '=== S8: after-midnight second gig is blocked (the original defect) ==='
DO $do$
DECLARE v record; a record; b1 uuid; b2 uuid;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S8 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S8 artist');
  b1 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
         '2026-11-07 23:00 Europe/Dublin','2026-11-08 03:00 Europe/Dublin');
  b2 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
         '2026-11-08 00:30 Europe/Dublin','2026-11-08 02:00 Europe/Dublin');
  PERFORM pg_temp.confirm(b1);
  BEGIN
    PERFORM pg_temp.confirm(b2);
    RAISE NOTICE 'S8 FAIL: artist confirmed at two venues on one night';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'S8 PASS: blocked by %', SQLERRM;
  END;
END $do$;

\echo '=== S9: same calendar day, different sessions, no longer refused ==='
DO $do$
DECLARE v record; a record; b1 uuid; b2 uuid; sd1 date; sd2 date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S9 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S9 artist');
  -- Finishes at 04:00 Friday morning, then plays Friday night.
  b1 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
         '2026-12-11 01:00 Europe/Dublin','2026-12-11 04:00 Europe/Dublin');
  b2 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
         '2026-12-11 21:00 Europe/Dublin','2026-12-11 23:00 Europe/Dublin');
  PERFORM pg_temp.confirm(b1);
  PERFORM pg_temp.confirm(b2);
  SELECT session_date INTO sd1 FROM book.bookings WHERE id=b1;
  SELECT session_date INTO sd2 FROM book.bookings WHERE id=b2;
  RAISE NOTICE 'S9 PASS: both confirmed on sessions % and %, same event_date', sd1, sd2;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'S9 FAIL: still refused - %', SQLERRM;
END $do$;

\echo '=== S10: a Saturday gig call can produce a Sunday 00:30 start ==='
DO $do$
DECLARE v record; a record; c uuid := gen_random_uuid(); b uuid; sd date; ed date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S10 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S10 artist');
  INSERT INTO book.gig_calls(id,venue_profile_id,event_date)
  VALUES (c, v.profile_id, DATE '2026-11-07');

  b := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
         '2026-11-08 00:30 Europe/Dublin','2026-11-08 02:30 Europe/Dublin', c);
  PERFORM pg_temp.confirm(b);
  SELECT session_date, event_date INTO sd, ed FROM book.bookings WHERE id=b;
  IF sd = DATE '2026-11-07' AND ed = DATE '2026-11-08' THEN
    RAISE NOTICE 'S10 PASS: call night %, booking event_date %, both satisfied', sd, ed;
  ELSE
    RAISE NOTICE 'S10 FAIL: session % event_date % - unexpected', sd, ed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'S10 FAIL: %', SQLERRM;
END $do$;

\echo '=== S11: a manual block is keyed on the session ==='
DO $do$
DECLARE v record; a record; b uuid;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','S11 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','S11 artist');
  -- Block the Saturday night; the gig starts after midnight on the Sunday.
  INSERT INTO book.availability_reservations(artist_profile_id,session_date,kind)
  VALUES (a.profile_id, DATE '2026-11-07', 'manual');
  b := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,
         '2026-11-08 00:30 Europe/Dublin','2026-11-08 02:30 Europe/Dublin');
  BEGIN
    PERFORM pg_temp.confirm(b);
    RAISE NOTICE 'S11 FAIL: confirmed despite a manual block on that night';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'S11 PASS: blocked by %', SQLERRM;
  END;
END $do$;
