-- 003_derived_event_date_messages_reviews.sql
--
-- PROBLEM -- after-midnight gig-call bookings could never be confirmed.
-- 002 moved the gig-call link onto session_date so a Saturday-night call can
-- produce a Sunday 00:30 start. But event_date was still written once, at
-- creation, and then frozen by guard_booking_update. An application has no
-- start time yet, so the service could only copy the call's night into it --
-- Saturday -- and the 00:30 Sunday offer then failed the start-date check at
-- confirmation, forever. The same was true of any venue request whose client
-- sent the night rather than the calendar date of the start.
--
-- FIX. event_date is derived from the current terms exactly as session_date
-- is, by the same trigger. Callers still supply a placeholder on insert (the
-- column is NOT NULL and an application has no start time), but once terms
-- carry a start, the database overwrites it. It stops being part of the
-- immutable identity: it can only change by a new terms revision, and
-- guard_booking_update already forbids a new revision once confirmed.
--
-- Also adds the booking message thread and two-way reviews the client API
-- (api.js) already calls.

BEGIN;

-- ============================================================
-- 1. Derive event_date alongside session_date
-- ============================================================

CREATE OR REPLACE FUNCTION book.set_session_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  s timestamptz;
  derived date;
BEGIN
  SELECT starts_at INTO s
  FROM book.booking_terms
  WHERE booking_id = NEW.id AND revision = NEW.terms_revision;

  IF s IS NOT NULL THEN
    derived := (s AT TIME ZONE 'Europe/Dublin')::date;

    -- A caller writing a date that contradicts the terms is refused rather
    -- than silently overwritten: the date moves only with a new revision.
    IF TG_OP = 'UPDATE'
       AND NEW.event_date IS DISTINCT FROM OLD.event_date
       AND NEW.event_date IS DISTINCT FROM derived THEN
      RAISE EXCEPTION 'The booking date follows the agreed start time; send a new terms revision to move it'
        USING ERRCODE = '23514';
    END IF;

    NEW.event_date := derived;
    NEW.session_date :=
      ((s AT TIME ZONE 'Europe/Dublin') - interval '6 hours')::date;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON COLUMN book.bookings.event_date IS
  'The calendar date the performance starts, in Europe/Dublin. Derived from '
  'the current terms by book.set_session_date(); before terms carry a start '
  'it holds the requested night as a placeholder. NOT the availability key '
  '-- see session_date.';

CREATE OR REPLACE FUNCTION book.guard_booking_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  t book.booking_terms%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- event_date is deliberately absent: it follows the terms.
    IF ROW(
      NEW.artist_profile_id,
      NEW.venue_profile_id,
      NEW.gig_call_id,
      NEW.origin
    ) IS DISTINCT FROM ROW(
      OLD.artist_profile_id,
      OLD.venue_profile_id,
      OLD.gig_call_id,
      OLD.origin
    ) THEN
      RAISE EXCEPTION 'Booking participants and origin are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'confirmed'
       AND (NEW.terms_revision <> OLD.terms_revision
            OR NEW.event_date <> OLD.event_date) THEN
      RAISE EXCEPTION 'Confirmed terms cannot be replaced'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'confirmed' THEN
    SELECT * INTO t
    FROM book.booking_terms
    WHERE booking_id = NEW.id
      AND revision = NEW.terms_revision;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Confirmation requires existing terms'
        USING ERRCODE = '23514';
    END IF;

    IF t.agreed_fee_minor IS NULL
       OR t.agreed_deposit_minor IS NULL
       OR t.starts_at IS NULL
       OR t.ends_at IS NULL THEN
      RAISE EXCEPTION 'Confirmation requires complete agreed terms'
        USING ERRCODE = '23514';
    END IF;

    IF (t.starts_at AT TIME ZONE 'Europe/Dublin')::date
       <> NEW.event_date THEN
      RAISE EXCEPTION 'Start timestamp does not match the booking date'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Re-derive every open booking so rows created before this migration pick
-- up the rule. Confirmed rows already satisfy it (the guard checked).
UPDATE book.bookings b
SET event_date = (t.starts_at AT TIME ZONE 'Europe/Dublin')::date
FROM book.booking_terms t
WHERE t.booking_id = b.id
  AND t.revision = b.terms_revision
  AND t.starts_at IS NOT NULL
  AND b.status <> 'confirmed'
  AND b.event_date <> (t.starts_at AT TIME ZONE 'Europe/Dublin')::date;

-- ============================================================
-- 2. Booking messages
-- ============================================================

CREATE TABLE book.booking_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES book.bookings(id),
  author_user_id uuid NOT NULL REFERENCES book.users(id),
  author_profile_id uuid NOT NULL REFERENCES book.profiles(id),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX booking_messages_by_booking
  ON book.booking_messages(booking_id, created_at);

-- ============================================================
-- 3. Reviews: one per side per booking
-- ============================================================

CREATE TABLE book.reviews (
  booking_id uuid NOT NULL REFERENCES book.bookings(id),
  author_profile_id uuid NOT NULL REFERENCES book.profiles(id),
  subject_profile_id uuid NOT NULL REFERENCES book.profiles(id),
  author_user_id uuid NOT NULL REFERENCES book.users(id),
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, author_profile_id),
  CHECK (author_profile_id <> subject_profile_id)
);

CREATE INDEX reviews_by_subject
  ON book.reviews(subject_profile_id, created_at DESC);

-- ============================================================
-- 4. Lookups the API reads on every request
-- ============================================================

CREATE INDEX gig_calls_open_by_date
  ON book.gig_calls(event_date)
  WHERE status = 'open';

CREATE INDEX availability_reservations_by_session
  ON book.availability_reservations(session_date);

REVOKE ALL ON ALL TABLES IN SCHEMA book FROM PUBLIC;

COMMIT;
