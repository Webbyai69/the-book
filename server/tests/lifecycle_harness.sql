-- Lifecycle state-machine harness.
-- Exercises the exact SQL that booking-lifecycle.js issues, against the real
-- constraints and triggers. Run after 001.

CREATE OR REPLACE FUNCTION pg_temp.mkparty(kind text, nm text)
RETURNS TABLE(user_id uuid, profile_id uuid) LANGUAGE plpgsql AS $$
DECLARE u uuid := gen_random_uuid(); p uuid := gen_random_uuid();
BEGIN
  INSERT INTO book.users(id,email) VALUES (u, u||'@example.invalid');
  INSERT INTO book.profiles(id,kind,name,county) VALUES (p,kind,nm,'Cork');
  IF kind='venue' THEN INSERT INTO book.venue_details(profile_id) VALUES (p);
  ELSE INSERT INTO book.artist_details(profile_id) VALUES (p); END IF;
  INSERT INTO book.profile_memberships(profile_id,user_id,role) VALUES (p,u,'owner');
  RETURN QUERY SELECT u,p;
END $$;

\echo '=== L1: venue_request -> requested -> accepted -> confirmed ==='
DO $$
DECLARE v record; a record; b uuid; d date := current_date + 200; st text;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','L1 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','L1 artist');

  -- createBookingRequest: booking first, terms after (deferred FK)
  INSERT INTO book.bookings(artist_profile_id,venue_profile_id,origin,event_date,
    status,terms_revision,created_by_user_id)
  VALUES (a.profile_id,v.profile_id,'venue_request',d,'requested',1,v.user_id)
  RETURNING id INTO b;
  INSERT INTO book.booking_terms(booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,1,(d||'T21:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',
              (d||'T23:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',50000,0,v.user_id);

  -- acceptBooking
  UPDATE book.bookings SET status='accepted',accepted_terms_revision=terms_revision,
    version=version+1 WHERE id=b;

  -- confirmBooking
  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b;

  SELECT status INTO st FROM book.bookings WHERE id=b;
  IF st='confirmed' THEN RAISE NOTICE 'L1 PASS: full venue-request path reaches confirmed';
  ELSE RAISE NOTICE 'L1 FAIL: ended at %', st; END IF;
END $$;

\echo '=== L2: gig_application -> applied -> offered -> accepted ==='
DO $$
DECLARE v record; a record; c uuid; b uuid; d date := current_date + 201; st text; tr int;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','L2 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','L2 artist');
  INSERT INTO book.gig_calls(venue_profile_id,event_date,budget_minor)
    VALUES (v.profile_id,d,65000) RETURNING id INTO c;

  -- createApplication: proposal-only terms (no times, budget as fee proposal)
  INSERT INTO book.bookings(artist_profile_id,venue_profile_id,gig_call_id,origin,
    event_date,status,terms_revision,created_by_user_id)
  VALUES (a.profile_id,v.profile_id,c,'gig_application',d,'applied',1,a.user_id)
  RETURNING id INTO b;
  INSERT INTO book.booking_terms(booking_id,revision,agreed_fee_minor,created_by_user_id)
  VALUES (b,1,65000,a.user_id);

  -- makeOffer: real terms as revision 2
  INSERT INTO book.booking_terms(booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,2,(d||'T21:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',
              (d||'T23:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',60000,10000,v.user_id);
  UPDATE book.bookings SET status='offered',terms_revision=2,
    accepted_terms_revision=NULL,version=version+1 WHERE id=b;

  -- acceptBooking
  UPDATE book.bookings SET status='accepted',accepted_terms_revision=terms_revision,
    version=version+1 WHERE id=b;

  SELECT status,terms_revision INTO st,tr FROM book.bookings WHERE id=b;
  IF st='accepted' AND tr=2 THEN RAISE NOTICE 'L2 PASS: application -> offer -> accepted at revision 2';
  ELSE RAISE NOTICE 'L2 FAIL: status=% revision=%', st, tr; END IF;
END $$;

\echo '=== L3: revising after acceptance clears the acceptance ==='
DO $$
DECLARE v record; a record; b uuid; d date := current_date + 202; st text; acc int;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','L3 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','L3 artist');
  INSERT INTO book.bookings(artist_profile_id,venue_profile_id,origin,event_date,
    status,terms_revision,created_by_user_id)
  VALUES (a.profile_id,v.profile_id,'venue_request',d,'requested',1,v.user_id) RETURNING id INTO b;
  INSERT INTO book.booking_terms(booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,1,(d||'T21:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',
              (d||'T23:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',50000,0,v.user_id);
  UPDATE book.bookings SET status='accepted',accepted_terms_revision=1,version=version+1 WHERE id=b;

  -- venue lowers the fee: new revision, acceptance cleared
  INSERT INTO book.booking_terms(booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,2,(d||'T21:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',
              (d||'T23:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',30000,0,v.user_id);
  UPDATE book.bookings SET status='offered',terms_revision=2,
    accepted_terms_revision=NULL,version=version+1 WHERE id=b;

  SELECT status,accepted_terms_revision INTO st,acc FROM book.bookings WHERE id=b;
  IF st='offered' AND acc IS NULL THEN
    RAISE NOTICE 'L3 PASS: revision after acceptance returns to offered, acceptance cleared';
  ELSE RAISE NOTICE 'L3 FAIL: status=% accepted_rev=%', st, acc; END IF;
END $$;

\echo '=== L4: a revised booking cannot be confirmed without re-acceptance ==='
DO $$
DECLARE v record; a record; b uuid; d date := current_date + 203;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','L4 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','L4 artist');
  INSERT INTO book.bookings(artist_profile_id,venue_profile_id,origin,event_date,
    status,terms_revision,created_by_user_id)
  VALUES (a.profile_id,v.profile_id,'venue_request',d,'offered',2,v.user_id) RETURNING id INTO b;
  INSERT INTO book.booking_terms(booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,1,(d||'T21:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',
              (d||'T23:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',50000,0,v.user_id),
         (b,2,(d||'T21:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',
              (d||'T23:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',30000,0,v.user_id);
  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b;
    RAISE NOTICE 'L4 FAIL: confirmed without acceptance of current terms';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'L4 PASS: %', SQLERRM;
  END;
END $$;

\echo '=== L5: terminal transitions, and cancel records which side ==='
DO $$
DECLARE v record; a record; b uuid; d date := current_date + 204; st text; n int;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','L5 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','L5 artist');
  INSERT INTO book.bookings(artist_profile_id,venue_profile_id,origin,event_date,
    status,terms_revision,accepted_terms_revision,created_by_user_id)
  VALUES (a.profile_id,v.profile_id,'venue_request',d,'accepted',1,1,v.user_id) RETURNING id INTO b;
  INSERT INTO book.booking_terms(booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,1,(d||'T21:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',
              (d||'T23:00:00')::timestamp AT TIME ZONE 'Europe/Dublin',50000,0,v.user_id);

  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b;
  SELECT count(*) INTO n FROM book.availability_reservations
    WHERE artist_profile_id=a.profile_id AND event_date=d;
  IF n<>1 THEN RAISE NOTICE 'L5 FAIL: no reservation after confirm'; RETURN; END IF;

  -- artist cancels: the refund-eligible case
  UPDATE book.bookings SET status='cancelled_by_artist',terminal_reason='artist_cancelled',
    version=version+1 WHERE id=b;
  SELECT status INTO st FROM book.bookings WHERE id=b;
  SELECT count(*) INTO n FROM book.availability_reservations
    WHERE artist_profile_id=a.profile_id AND event_date=d;
  IF st='cancelled_by_artist' AND n=0 THEN
    RAISE NOTICE 'L5 PASS: cancelled_by_artist recorded, reservation released';
  ELSE RAISE NOTICE 'L5 FAIL: status=% reservations=%', st, n; END IF;
END $$;

\echo '=== L6: a second application by the same act is rejected ==='
DO $$
DECLARE v record; a record; c uuid; b uuid; d date := current_date + 205;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','L6 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','L6 artist');
  INSERT INTO book.gig_calls(venue_profile_id,event_date) VALUES (v.profile_id,d) RETURNING id INTO c;
  INSERT INTO book.bookings(artist_profile_id,venue_profile_id,gig_call_id,origin,
    event_date,status,terms_revision,created_by_user_id)
  VALUES (a.profile_id,v.profile_id,c,'gig_application',d,'applied',1,a.user_id) RETURNING id INTO b;
  INSERT INTO book.booking_terms(booking_id,revision,created_by_user_id) VALUES (b,1,a.user_id);
  BEGIN
    INSERT INTO book.bookings(artist_profile_id,venue_profile_id,gig_call_id,origin,
      event_date,status,terms_revision,created_by_user_id)
    VALUES (a.profile_id,v.profile_id,c,'gig_application',d,'applied',1,a.user_id);
    RAISE NOTICE 'L6 FAIL: duplicate application accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'L6 PASS: blocked by %', SQLERRM;
  END;
END $$;

\echo '=== L7: origin/gig_call consistency is enforced ==='
DO $$
DECLARE v record; a record; d date := current_date + 206;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','L7 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','L7 artist');
  BEGIN
    INSERT INTO book.bookings(artist_profile_id,venue_profile_id,origin,event_date,
      status,terms_revision,created_by_user_id)
    VALUES (a.profile_id,v.profile_id,'gig_application',d,'applied',1,a.user_id);
    RAISE NOTICE 'L7 FAIL: gig_application accepted with no gig call';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'L7 PASS: %', SQLERRM;
  END;
END $$;
