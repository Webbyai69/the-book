-- 02_overlap_hole.sql
--
-- Continues 01 in the SAME psql session (reuses its pg_temp helpers).
--
-- Applies Phase 5 items 1 and 2 but NOT item 3, then shows two genuinely
-- overlapping gigs both confirming. This is the state a migration lands in
-- if it moves availability to session_date without forbidding a performance
-- from crossing the next 06:00 boundary.
--
-- Verified on PostgreSQL 16.15.

\set ON_ERROR_STOP on
DO $guard$
BEGIN
  IF current_database() <> 'thebook_scratch' THEN
    RAISE EXCEPTION
      'Refusing to run on %. This script drops indexes and constraints. Use thebook_scratch.',
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

\echo ''
\echo '=============================================================='
\echo ' ITEM 2 - availability_reservations repointed to session_date'
\echo '=============================================================='
ALTER TABLE book.availability_reservations
  DROP CONSTRAINT availability_reservations_booking_id_artist_profile_id_eve_fkey;
ALTER TABLE book.availability_reservations ADD COLUMN session_date date;
UPDATE book.availability_reservations r
  SET session_date = b.session_date FROM book.bookings b WHERE r.booking_id = b.id;
UPDATE book.availability_reservations SET session_date = event_date WHERE session_date IS NULL;
ALTER TABLE book.availability_reservations ALTER COLUMN session_date SET NOT NULL;
ALTER TABLE book.availability_reservations DROP CONSTRAINT availability_reservations_pkey;
ALTER TABLE book.availability_reservations
  ADD CONSTRAINT availability_reservations_pkey PRIMARY KEY (artist_profile_id, session_date);

CREATE OR REPLACE FUNCTION book.sync_booking_reservation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status = 'confirmed' THEN
    IF TG_OP = 'INSERT' OR OLD.status <> 'confirmed' THEN
      INSERT INTO book.availability_reservations (
        artist_profile_id, event_date, session_date, kind, booking_id
      ) VALUES (
        NEW.artist_profile_id, NEW.event_date, NEW.session_date, 'booking', NEW.id
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'confirmed' THEN
      DELETE FROM book.availability_reservations
      WHERE booking_id = NEW.id AND kind = 'booking';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

-- Required, not optional. While this index survives it both masks the hole
-- below AND falsely rejects legitimate bookings -- see 03_false_rejection.sql.
DROP INDEX book.bookings_confirmed_artist_date;

\echo ''
\echo '=============================================================='
\echo ' C - items 1+2 applied, item 3 absent: overlapping pair'
\echo '=============================================================='
DO $do$
DECLARE v record; a record; b1 uuid; b2 uuid; sd1 date; sd2 date; n int; ov interval;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','C venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','C artist');

  b1 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,'2026-11-28',
          '2026-11-28 05:00 Europe/Dublin','2026-11-28 07:00 Europe/Dublin');
  b2 := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,'2026-11-28',
          '2026-11-28 06:30 Europe/Dublin','2026-11-28 08:00 Europe/Dublin');

  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b1;
  SELECT session_date INTO sd1 FROM book.bookings WHERE id=b1;
  RAISE NOTICE 'C: gig 1  05:00 to 07:00   event_date=2026-11-28  session_date=%', sd1;

  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b2;
    SELECT session_date INTO sd2 FROM book.bookings WHERE id=b2;
    RAISE NOTICE 'C: gig 2  06:30 to 08:00   event_date=2026-11-28  session_date=%', sd2;

    SELECT count(*) INTO n FROM book.bookings
      WHERE artist_profile_id=a.profile_id AND status='confirmed';
    SELECT LEAST(t1.ends_at, t2.ends_at) - GREATEST(t1.starts_at, t2.starts_at)
      INTO ov
      FROM book.booking_terms t1, book.booking_terms t2
      WHERE t1.booking_id=b1 AND t1.revision=1
        AND t2.booking_id=b2 AND t2.revision=1;

    RAISE NOTICE 'C FAIL: both confirmed - % bookings for one artist, overlapping %', n, ov;
    RAISE NOTICE 'C FAIL: reservations held for sessions: %',
      (SELECT string_agg(session_date::text, ', ' ORDER BY session_date)
       FROM book.availability_reservations WHERE artist_profile_id=a.profile_id);
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'C PASS: blocked by %', SQLERRM;
  END;
END $do$;

\echo ''
\echo '=============================================================='
\echo ' D - why item 3 fixes it: a booking crossing the 06:00 seam'
\echo '=============================================================='
DO $do$
DECLARE v record; a record; b uuid; sd date;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','D venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','D artist');

  b := pg_temp.mkgig(v.user_id,v.profile_id,a.profile_id,'2026-12-05',
         '2026-12-05 05:00 Europe/Dublin','2026-12-05 07:00 Europe/Dublin');
  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b;
  SELECT session_date INTO sd FROM book.bookings WHERE id=b;

  RAISE NOTICE 'D: a 05:00 to 07:00 booking carries session_date % and crosses 06:00.', sd;
  RAISE NOTICE 'D: it occupies time belonging to BOTH session % and session %.', sd, sd + 1;
  RAISE NOTICE 'D: item 3 rejects this at confirmation. Nothing here does.';
  RAISE NOTICE 'D: with it, session S owns [S 06:00, S+1 06:00] and the simple';
  RAISE NOTICE 'D: unique index is sufficient - no exclusion constraint needed.';
END $do$;
