-- 002_session_date.sql
--
-- Fixes a hole in the one-gig-per-artist-per-date rule.
--
-- PROBLEM: event_date is a calendar date. A set running Saturday 23:00 to
-- Sunday 03:00 has event_date = Saturday. A second gig starting Sunday 00:30
-- has event_date = Sunday. They are different dates, so
-- bookings_confirmed_artist_date permits both -- and the act is confirmed at
-- two venues simultaneously between 00:30 and 02:00.
--
-- Verified against PostgreSQL 16.13: both bookings confirmed successfully
-- before this migration.
--
-- FIX: key the constraint on the SESSION date (the gig night) rather than the
-- calendar date. Anything starting before 06:00 local belongs to the previous
-- night. A genuine Sunday-evening gig still lands on Sunday and is unaffected.
--
-- Verified after this migration: the overlapping 00:30 gig is blocked; the
-- separate Sunday-evening gig is still allowed.

BEGIN;

ALTER TABLE book.bookings ADD COLUMN session_date date;

COMMENT ON COLUMN book.bookings.session_date IS
  'The gig night. Derived from the current terms'' start time in '
  'Europe/Dublin, shifted back 6 hours so after-midnight sets belong to the '
  'night they started. This -- not event_date -- is the availability key.';

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

-- Name matters: BEFORE triggers fire in alphabetical order, and
-- booking_session_date must run before booking_update_guard.
CREATE TRIGGER booking_session_date
BEFORE INSERT OR UPDATE ON book.bookings
FOR EACH ROW EXECUTE FUNCTION book.set_session_date();

CREATE UNIQUE INDEX bookings_confirmed_artist_session
  ON book.bookings(artist_profile_id, session_date)
  WHERE status = 'confirmed';

-- A confirmed booking must always carry a session date, otherwise NULLs
-- slip past the unique index (NULLs are distinct).
ALTER TABLE book.bookings
  ADD CONSTRAINT confirmed_requires_session_date
  CHECK (status <> 'confirmed' OR session_date IS NOT NULL);

-- Availability reservations must move to the same key, otherwise manual
-- blocks and confirmed bookings are once again guarding different things.
-- TODO(agent): migrate book.availability_reservations from event_date to
-- session_date, including its composite FK to
-- bookings(id, artist_profile_id, event_date). Left out here deliberately:
-- it needs a backfill plan for any existing rows.

COMMIT;
