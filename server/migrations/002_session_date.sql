-- 002_session_date.sql
--
-- Moves artist availability from the calendar date to the SESSION date (the
-- gig night), and makes that key airtight.
--
-- PROBLEM 1 -- after-midnight sets escape the availability key.
-- event_date is a calendar date. A set running Saturday 23:00 to Sunday 03:00
-- has event_date = Saturday. A second gig starting Sunday 00:30 has
-- event_date = Sunday. Different dates, so bookings_confirmed_artist_date
-- permits both, and the act is confirmed at two venues between 00:30 and 02:00.
--
-- PROBLEM 2 -- the calendar key also refuses bookings it should allow.
-- An artist finishing at 04:00 on the Friday morning cannot take a Friday
-- night gig: different sessions, no overlap, but the same event_date.
--
-- FIX. Key availability on the session date: anything starting before 06:00
-- local belongs to the previous night. Problems 1 and 2 are the same index
-- seen from two sides, so bookings_confirmed_artist_date is retired here.
--
-- Retiring it is what makes the 06:00 boundary rule load-bearing rather than
-- decorative. Without that rule, two gigs at 05:00-07:00 and 06:30-08:00 fall
-- on different sessions, nothing blocks either, and they overlap for half an
-- hour. With it, every booking on session S occupies at most
-- [S 06:00, S+1 06:00], so two bookings on different sessions cannot overlap
-- by construction -- which is what lets the simple unique index stand in for
-- an exclusion constraint.
--
-- These parts are not separable. Items 1, 2 and 4 without item 3 are strictly
-- worse than the schema they replace.
--
-- Verified on PostgreSQL 16.15. The reproduction for the pre-fix behaviour is
-- in server/tests/overlap; the tests for this migration are in
-- server/tests/session_date_harness.sql.

BEGIN;

-- ============================================================
-- 1. Name the anonymous CHECK constraints
--
-- Verified against pg_get_constraintdef rather than assumed. If 001 ever
-- changes shape, this aborts instead of renaming the wrong constraint.
-- ============================================================

DO $$
DECLARE
  d text;
BEGIN
  SELECT pg_get_constraintdef(oid, true) INTO d
  FROM pg_constraint WHERE conrelid = 'book.bookings'::regclass AND conname = 'bookings_check';
  IF d IS NULL OR d NOT LIKE '%gig_call_id IS NOT NULL%' OR d NOT LIKE '%venue_request%' THEN
    RAISE EXCEPTION 'bookings_check is not the origin/gig_call rule: %', coalesce(d, '<missing>');
  END IF;

  SELECT pg_get_constraintdef(oid, true) INTO d
  FROM pg_constraint WHERE conrelid = 'book.bookings'::regclass AND conname = 'bookings_check1';
  IF d IS NULL OR d NOT LIKE '%accepted_terms_revision = terms_revision%' THEN
    RAISE EXCEPTION 'bookings_check1 is not the accepted-terms rule: %', coalesce(d, '<missing>');
  END IF;

  SELECT pg_get_constraintdef(oid, true) INTO d
  FROM pg_constraint WHERE conrelid = 'book.bookings'::regclass AND conname = 'bookings_check2';
  IF d IS NULL OR d NOT LIKE '%confirmed_at IS NOT NULL%' THEN
    RAISE EXCEPTION 'bookings_check2 is not the confirmed-timestamp rule: %', coalesce(d, '<missing>');
  END IF;
END $$;

ALTER TABLE book.bookings RENAME CONSTRAINT bookings_check  TO bookings_origin_matches_gig_call;
ALTER TABLE book.bookings RENAME CONSTRAINT bookings_check1 TO bookings_accepted_terms_current;
ALTER TABLE book.bookings RENAME CONSTRAINT bookings_check2 TO bookings_confirmed_requires_timestamp;

-- ============================================================
-- 2. The session boundary
--
-- 06:00 is safe to construct in Europe/Dublin: the DST transitions happen at
-- 01:00 and 02:00 local, so 06:00 is never ambiguous and never skipped. The
-- same is not true of the 01:00-02:00 window, which is why the boundary is
-- built from a literal time-of-day rather than by adding an interval to a
-- timestamptz.
-- ============================================================

CREATE OR REPLACE FUNCTION book.session_ends_by(s date)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT ((s + 1)::timestamp + time '06:00') AT TIME ZONE 'Europe/Dublin';
$$;

COMMENT ON FUNCTION book.session_ends_by(date) IS
  'The instant session s ends: 06:00 Europe/Dublin on the following morning. '
  'A confirmed performance may not run past this.';

-- ============================================================
-- 3. session_date column
-- ============================================================

ALTER TABLE book.bookings ADD COLUMN session_date date;

COMMENT ON COLUMN book.bookings.session_date IS
  'The gig night. Derived from the current terms'' start time in '
  'Europe/Dublin, shifted back 6 hours so after-midnight sets belong to the '
  'night they started. This -- not event_date -- is the availability key.';

COMMENT ON COLUMN book.bookings.event_date IS
  'The calendar date the performance starts, in Europe/Dublin. Immutable, and '
  'checked against the terms at confirmation. It is NOT the availability key '
  'and it is NOT necessarily the advertised night: a Saturday gig call can '
  'produce a booking with event_date on the Sunday. See session_date.';

-- ============================================================
-- 4. Backfill
--
-- Done with a plain UPDATE before the triggers exist, so the checks below
-- report every offending row at once with a usable message rather than
-- failing on the first one inside a trigger.
-- ============================================================

UPDATE book.bookings b
SET session_date = ((t.starts_at AT TIME ZONE 'Europe/Dublin') - interval '6 hours')::date
FROM book.booking_terms t
WHERE t.booking_id = b.id
  AND t.revision = b.terms_revision
  AND t.starts_at IS NOT NULL;

-- ============================================================
-- 5. Collision detection
--
-- Aborts. Never deletes a block, never cancels a booking: a human decides
-- which of two colliding confirmed gigs is the real one.
-- ============================================================

DO $$
DECLARE
  offenders text;
  n bigint;
BEGIN
  -- 5a. A confirmed booking with no derivable session date.
  SELECT count(*), string_agg(id::text, ', ' ORDER BY id) INTO n, offenders
  FROM book.bookings WHERE status = 'confirmed' AND session_date IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'ABORTING: % confirmed booking(s) have no start time, so no session date can be derived: %',
      n, offenders
      USING HINT = 'Give each one complete terms, or cancel it, then re-run this migration.';
  END IF;

  -- 5b. A confirmed booking that runs past 06:00 the following morning.
  SELECT count(*), string_agg(format('%s (session %s, ends %s)', b.id, b.session_date, t.ends_at), '; ' ORDER BY b.id)
    INTO n, offenders
  FROM book.bookings b
  JOIN book.booking_terms t ON t.booking_id = b.id AND t.revision = b.terms_revision
  WHERE b.status = 'confirmed'
    AND b.session_date IS NOT NULL
    AND t.ends_at IS NOT NULL
    AND t.ends_at > book.session_ends_by(b.session_date);
  IF n > 0 THEN
    RAISE EXCEPTION
      'ABORTING: % confirmed booking(s) run past 06:00 the morning after their session: %',
      n, offenders
      USING HINT = 'Shorten the terms or cancel the booking. This migration will not truncate a gig.';
  END IF;

  -- 5c. Two confirmed bookings for one artist on one session.
  SELECT count(*), string_agg(detail, '; ') INTO n, offenders
  FROM (
    SELECT format('artist %s session %s: %s',
                  artist_profile_id, session_date, string_agg(id::text, ' + ' ORDER BY id)) AS detail
    FROM book.bookings
    WHERE status = 'confirmed' AND session_date IS NOT NULL
    GROUP BY artist_profile_id, session_date
    HAVING count(*) > 1
  ) c;
  IF n > 0 THEN
    RAISE EXCEPTION
      'ABORTING: % artist/session pair(s) already hold two confirmed bookings: %',
      n, offenders
      USING HINT = 'These are real double-bookings that the old calendar key allowed. Resolve them by hand.';
  END IF;
END $$;

-- ============================================================
-- 6. Derive session_date on write
--
-- Trigger name matters: BEFORE triggers fire in alphabetical order, and
-- booking_session_date must run before booking_session_guard (which reads
-- the value) and before booking_update_guard.
-- ============================================================

CREATE OR REPLACE FUNCTION book.set_session_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  s timestamptz;
BEGIN
  SELECT starts_at INTO s
  FROM book.booking_terms
  WHERE booking_id = NEW.id AND revision = NEW.terms_revision;

  IF s IS NOT NULL THEN
    NEW.session_date :=
      ((s AT TIME ZONE 'Europe/Dublin') - interval '6 hours')::date;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_session_date
BEFORE INSERT OR UPDATE ON book.bookings
FOR EACH ROW EXECUTE FUNCTION book.set_session_date();

-- ============================================================
-- 7. The 06:00 restriction
--
-- Enforced at confirmation, which is the only status the unique index
-- constrains. A draft or an offer may carry any terms; it simply cannot be
-- confirmed while they cross the boundary.
--
-- ERRCODE 23514 so src/db/errors.js maps it to INVALID_BOOKING_STATE without
-- needing a new case.
-- ============================================================

CREATE OR REPLACE FUNCTION book.enforce_session_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  t book.booking_terms%ROWTYPE;
BEGIN
  IF NEW.status = 'confirmed' AND NEW.session_date IS NOT NULL THEN
    SELECT * INTO t
    FROM book.booking_terms
    WHERE booking_id = NEW.id AND revision = NEW.terms_revision;

    IF FOUND AND t.ends_at IS NOT NULL
       AND t.ends_at > book.session_ends_by(NEW.session_date) THEN
      RAISE EXCEPTION
        'A performance may not run past 06:00 the morning after its session (session %, ends %)',
        NEW.session_date, t.ends_at
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_session_guard
BEFORE INSERT OR UPDATE ON book.bookings
FOR EACH ROW EXECUTE FUNCTION book.enforce_session_boundary();

-- ============================================================
-- 8. The availability key moves
-- ============================================================

-- A confirmed booking must always carry a session date, otherwise NULLs slip
-- past the unique index, NULLs being distinct.
ALTER TABLE book.bookings
  ADD CONSTRAINT bookings_confirmed_requires_session_date
  CHECK (status <> 'confirmed' OR session_date IS NOT NULL);

CREATE UNIQUE INDEX bookings_confirmed_artist_session
  ON book.bookings(artist_profile_id, session_date)
  WHERE status = 'confirmed';

-- Retired: see PROBLEM 2 in the header. While this survives it both masks the
-- overlap defect and falsely rejects legitimate adjacent-session bookings.
DROP INDEX book.bookings_confirmed_artist_date;

-- Referenced by the reservation FK below.
CREATE UNIQUE INDEX bookings_id_artist_session_key
  ON book.bookings(id, artist_profile_id, session_date);

-- ============================================================
-- 9. availability_reservations repointed to the session
-- ============================================================

ALTER TABLE book.availability_reservations
  DROP CONSTRAINT availability_reservations_booking_id_artist_profile_id_eve_fkey;

ALTER TABLE book.availability_reservations ADD COLUMN session_date date;

-- A booking's reservation takes the booking's session.
UPDATE book.availability_reservations r
SET session_date = b.session_date
FROM book.bookings b
WHERE r.booking_id = b.id;

-- A manual block was entered as a night, so its calendar date is its session.
UPDATE book.availability_reservations
SET session_date = event_date
WHERE session_date IS NULL;

DO $$
DECLARE
  offenders text;
  n bigint;
BEGIN
  SELECT count(*), string_agg(id::text, ', ') INTO n, offenders
  FROM (SELECT booking_id::text AS id FROM book.availability_reservations WHERE session_date IS NULL) x;
  IF n > 0 THEN
    RAISE EXCEPTION
      'ABORTING: % reservation(s) have no session date (booking ids: %)', n, offenders
      USING HINT = 'The referenced booking has no start time. Resolve it, then re-run.';
  END IF;

  SELECT count(*), string_agg(detail, '; ') INTO n, offenders
  FROM (
    SELECT format('artist %s session %s (%s rows)', artist_profile_id, session_date, count(*)) AS detail
    FROM book.availability_reservations
    GROUP BY artist_profile_id, session_date
    HAVING count(*) > 1
  ) c;
  IF n > 0 THEN
    RAISE EXCEPTION
      'ABORTING: % artist/session pair(s) would collide in availability_reservations: %',
      n, offenders
      USING HINT = 'Typically a manual block on the same night as a confirmed booking. Remove the block by hand; this migration will not delete it.';
  END IF;
END $$;

ALTER TABLE book.availability_reservations ALTER COLUMN session_date SET NOT NULL;
ALTER TABLE book.availability_reservations DROP CONSTRAINT availability_reservations_pkey;
ALTER TABLE book.availability_reservations
  ADD CONSTRAINT availability_reservations_pkey PRIMARY KEY (artist_profile_id, session_date);

-- event_date has no remaining meaning here. Leaving it would recreate exactly
-- the bug this migration closes: two columns guarding different things.
ALTER TABLE book.availability_reservations DROP COLUMN event_date;

ALTER TABLE book.availability_reservations
  ADD CONSTRAINT availability_reservations_booking_session_fkey
  FOREIGN KEY (booking_id, artist_profile_id, session_date)
  REFERENCES book.bookings(id, artist_profile_id, session_date);

CREATE OR REPLACE FUNCTION book.sync_booking_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'confirmed' THEN
    IF TG_OP = 'INSERT' OR OLD.status <> 'confirmed' THEN
      INSERT INTO book.availability_reservations (
        artist_profile_id, session_date, kind, booking_id
      ) VALUES (
        NEW.artist_profile_id, NEW.session_date, 'booking', NEW.id
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'confirmed' THEN
      DELETE FROM book.availability_reservations
      WHERE booking_id = NEW.id AND kind = 'booking';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================
-- 10. The gig call link moves to the session
--
-- The old FK was (gig_call_id, venue_profile_id, event_date) against the
-- call's event_date. Combined with guard_booking_update, which requires a
-- confirmed booking's event_date to equal the calendar date of its start, it
-- made a legitimate booking impossible: a Saturday-night gig call producing a
-- Sunday 00:30 start needs event_date = Sunday for the guard and
-- event_date = Saturday for the FK.
--
-- Resolved by splitting the two jobs the old FK was doing:
--   - the call and venue must match, enforced from creation;
--   - the booking must be for the night the call advertises, enforced on
--     session_date once terms exist.
-- event_date keeps its one meaning -- the calendar date the performance
-- starts -- and stays immutable.
--
-- The session FK is not enforced while session_date is NULL, which is the
-- window between creating an application and giving it terms. By confirmation
-- it is always enforced, because bookings_confirmed_requires_session_date
-- makes a NULL session date unconfirmable.
-- ============================================================

CREATE UNIQUE INDEX gig_calls_id_venue_key
  ON book.gig_calls(id, venue_profile_id);

ALTER TABLE book.bookings
  DROP CONSTRAINT bookings_gig_call_id_venue_profile_id_event_date_fkey;

ALTER TABLE book.bookings
  ADD CONSTRAINT bookings_gig_call_venue_fkey
  FOREIGN KEY (gig_call_id, venue_profile_id)
  REFERENCES book.gig_calls(id, venue_profile_id);

ALTER TABLE book.bookings
  ADD CONSTRAINT bookings_gig_call_session_fkey
  FOREIGN KEY (gig_call_id, venue_profile_id, session_date)
  REFERENCES book.gig_calls(id, venue_profile_id, event_date);

COMMENT ON COLUMN book.gig_calls.event_date IS
  'The night the call advertises. A booking filling this call must have '
  'session_date equal to it; the booking''s own event_date may be the '
  'following calendar day for an after-midnight start.';

COMMIT;
