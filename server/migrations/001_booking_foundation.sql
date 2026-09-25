BEGIN;

CREATE SCHEMA book;
REVOKE ALL ON SCHEMA book FROM PUBLIC;

CREATE TABLE book.users (
  -- Supabase Auth user ID, verified by the API.
  id uuid PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE book.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('artist', 'venue')),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  county text NOT NULL CHECK (county IN (
    'Carlow', 'Cavan', 'Clare', 'Cork', 'Donegal', 'Dublin',
    'Galway', 'Kerry', 'Kildare', 'Kilkenny', 'Laois', 'Leitrim',
    'Limerick', 'Longford', 'Louth', 'Mayo', 'Meath', 'Monaghan',
    'Offaly', 'Roscommon', 'Sligo', 'Tipperary', 'Waterford',
    'Westmeath', 'Wexford', 'Wicklow'
  )),
  bio text NOT NULL DEFAULT '',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, kind)
);

CREATE TABLE book.profile_memberships (
  profile_id uuid NOT NULL REFERENCES book.profiles(id),
  user_id uuid NOT NULL REFERENCES book.users(id),
  role text NOT NULL CHECK (role IN ('owner', 'manager')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, user_id)
);

CREATE INDEX profile_memberships_by_user
  ON book.profile_memberships(user_id, profile_id);

CREATE TABLE book.artist_details (
  profile_id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'artist' CHECK (kind = 'artist'),
  act_type text NOT NULL DEFAULT 'Band'
    CHECK (act_type IN ('Band', 'Solo', 'Duo or trio', 'DJ')),
  genres text[] NOT NULL DEFAULT '{}',
  stated_fee_minor integer CHECK (stated_fee_minor >= 0),
  currency text NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  FOREIGN KEY (profile_id, kind)
    REFERENCES book.profiles(id, kind)
);

CREATE TABLE book.venue_details (
  profile_id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'venue' CHECK (kind = 'venue'),
  timezone text NOT NULL DEFAULT 'Europe/Dublin'
    CHECK (timezone = 'Europe/Dublin'),
  FOREIGN KEY (profile_id, kind)
    REFERENCES book.profiles(id, kind)
);

CREATE TABLE book.gig_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_profile_id uuid NOT NULL
    REFERENCES book.venue_details(profile_id),
  event_date date NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'filled', 'cancelled')),
  budget_minor integer CHECK (budget_minor >= 0),
  currency text NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  details text NOT NULL DEFAULT '',
  filled_booking_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, venue_profile_id, event_date),
  CHECK (
    (status = 'filled' AND filled_booking_id IS NOT NULL)
    OR
    (status <> 'filled' AND filled_booking_id IS NULL)
  )
);

CREATE TABLE book.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  artist_profile_id uuid NOT NULL
    REFERENCES book.artist_details(profile_id),
  venue_profile_id uuid NOT NULL
    REFERENCES book.venue_details(profile_id),

  gig_call_id uuid,
  origin text NOT NULL
    CHECK (origin IN ('venue_request', 'gig_application')),

  -- The gig's start date in Europe/Dublin.
  -- This is the one-gig-per-date reservation key.
  event_date date NOT NULL,

  status text NOT NULL CHECK (status IN (
    'requested',
    'applied',
    'offered',
    'accepted',
    'confirmed',
    'declined',
    'withdrawn',
    'cancelled_by_artist',
    'cancelled_by_venue',
    'not_selected'
  )),

  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  terms_revision integer NOT NULL DEFAULT 1 CHECK (terms_revision > 0),
  accepted_terms_revision integer,
  terminal_reason text,

  created_by_user_id uuid NOT NULL REFERENCES book.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,

  UNIQUE (id, artist_profile_id, event_date),
  UNIQUE (id, gig_call_id),

  FOREIGN KEY (gig_call_id, venue_profile_id, event_date)
    REFERENCES book.gig_calls(id, venue_profile_id, event_date),

  CHECK (
    (origin = 'gig_application' AND gig_call_id IS NOT NULL)
    OR
    (origin = 'venue_request' AND gig_call_id IS NULL)
  ),

  CHECK (
    status NOT IN ('accepted', 'confirmed')
    OR (
      accepted_terms_revision IS NOT NULL
      AND accepted_terms_revision = terms_revision
    )
  ),

  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL)
);

-- Immutable historical records of proposed/agreed terms.
CREATE TABLE book.booking_terms (
  booking_id uuid NOT NULL REFERENCES book.bookings(id),
  revision integer NOT NULL CHECK (revision > 0),

  starts_at timestamptz,
  ends_at timestamptz,
  arrival_at timestamptz,
  soundcheck_at timestamptz,

  agreed_fee_minor integer CHECK (agreed_fee_minor >= 0),
  agreed_deposit_minor integer CHECK (agreed_deposit_minor >= 0),
  currency text NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),

  details text NOT NULL DEFAULT '',
  created_by_user_id uuid NOT NULL REFERENCES book.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (booking_id, revision),

  CHECK (
    (starts_at IS NULL AND ends_at IS NULL)
    OR
    (
      starts_at IS NOT NULL
      AND ends_at IS NOT NULL
      AND ends_at > starts_at
    )
  ),

  CHECK (
    agreed_fee_minor IS NULL
    OR agreed_deposit_minor IS NULL
    OR agreed_deposit_minor <= agreed_fee_minor
  )
);

ALTER TABLE book.bookings
  ADD CONSTRAINT booking_current_terms_fk
  FOREIGN KEY (id, terms_revision)
  REFERENCES book.booking_terms(booking_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE book.bookings
  ADD CONSTRAINT booking_accepted_terms_fk
  FOREIGN KEY (id, accepted_terms_revision)
  REFERENCES book.booking_terms(booking_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE book.gig_calls
  ADD CONSTRAINT gig_call_filled_booking_fk
  FOREIGN KEY (filled_booking_id, id)
  REFERENCES book.bookings(id, gig_call_id);

CREATE UNIQUE INDEX bookings_confirmed_artist_date
  ON book.bookings(artist_profile_id, event_date)
  WHERE status = 'confirmed';

CREATE UNIQUE INDEX bookings_confirmed_gig_call
  ON book.bookings(gig_call_id)
  WHERE status = 'confirmed' AND gig_call_id IS NOT NULL;

CREATE UNIQUE INDEX bookings_one_application
  ON book.bookings(gig_call_id, artist_profile_id)
  WHERE gig_call_id IS NOT NULL;

CREATE INDEX bookings_by_venue
  ON book.bookings(venue_profile_id, event_date);

CREATE INDEX bookings_by_artist
  ON book.bookings(artist_profile_id, event_date);

-- Both confirmed bookings and manual blocks occupy this same key.
CREATE TABLE book.availability_reservations (
  artist_profile_id uuid NOT NULL
    REFERENCES book.artist_details(profile_id),
  event_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('manual', 'booking')),
  booking_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (artist_profile_id, event_date),

  FOREIGN KEY (booking_id, artist_profile_id, event_date)
    REFERENCES book.bookings(id, artist_profile_id, event_date),

  CHECK (
    (kind = 'manual' AND booking_id IS NULL)
    OR
    (kind = 'booking' AND booking_id IS NOT NULL)
  )
);

CREATE TABLE book.booking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES book.bookings(id),
  actor_user_id uuid NOT NULL REFERENCES book.users(id),
  actor_profile_id uuid NOT NULL REFERENCES book.profiles(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE book.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES book.booking_events(id),
  recipient_user_id uuid NOT NULL REFERENCES book.users(id),
  profile_id uuid NOT NULL REFERENCES book.profiles(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (event_id, recipient_user_id, profile_id)
);

CREATE INDEX notifications_by_recipient
  ON book.notifications(recipient_user_id, profile_id, created_at DESC);

-- Queue only: a delivery worker is a separate implementation.
CREATE TABLE book.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL UNIQUE REFERENCES book.notifications(id),
  channel text NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_pending
  ON book.outbox_events(available_at)
  WHERE delivered_at IS NULL;

CREATE TABLE book.idempotency_keys (
  user_id uuid NOT NULL REFERENCES book.users(id),
  profile_id uuid NOT NULL REFERENCES book.profiles(id),
  operation text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, profile_id, operation, key)
);

-- Never edit an accepted historical record in place.
CREATE FUNCTION book.reject_terms_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Booking terms are immutable; create a new revision'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER booking_terms_immutable
BEFORE UPDATE OR DELETE ON book.booking_terms
FOR EACH ROW EXECUTE FUNCTION book.reject_terms_mutation();

-- Booking participants, origin and reservation date cannot silently change.
-- A rescheduling workflow needs its own implementation.
CREATE FUNCTION book.guard_booking_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  t book.booking_terms%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.artist_profile_id,
      NEW.venue_profile_id,
      NEW.event_date,
      NEW.gig_call_id,
      NEW.origin
    ) IS DISTINCT FROM ROW(
      OLD.artist_profile_id,
      OLD.venue_profile_id,
      OLD.event_date,
      OLD.gig_call_id,
      OLD.origin
    ) THEN
      RAISE EXCEPTION 'Booking identity and date are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'confirmed'
       AND NEW.terms_revision <> OLD.terms_revision THEN
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

CREATE TRIGGER booking_update_guard
BEFORE INSERT OR UPDATE ON book.bookings
FOR EACH ROW EXECUTE FUNCTION book.guard_booking_update();

-- A status change cannot bypass the shared reservation mechanism.
CREATE FUNCTION book.sync_booking_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'confirmed' THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO book.availability_reservations (
        artist_profile_id, event_date, kind, booking_id
      ) VALUES (
        NEW.artist_profile_id, NEW.event_date, 'booking', NEW.id
      );
    ELSIF OLD.status <> 'confirmed' THEN
      INSERT INTO book.availability_reservations (
        artist_profile_id, event_date, kind, booking_id
      ) VALUES (
        NEW.artist_profile_id, NEW.event_date, 'booking', NEW.id
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'confirmed' THEN
      DELETE FROM book.availability_reservations
      WHERE booking_id = NEW.id
        AND kind = 'booking';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_reservation_sync
AFTER INSERT OR UPDATE ON book.bookings
FOR EACH ROW EXECUTE FUNCTION book.sync_booking_reservation();

REVOKE ALL ON ALL TABLES IN SCHEMA book FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA book FROM PUBLIC;

COMMIT;
