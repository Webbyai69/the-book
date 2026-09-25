\set ON_ERROR_STOP off
\set QUIET on
\pset format unaligned
\pset tuples_only on

-- ============================================================
-- SQL equivalent of the integration tests, exercising the real
-- constraints and triggers. Single-session cases only;
-- concurrency is driven separately by the shell harness.
-- ============================================================

CREATE OR REPLACE FUNCTION pg_temp.mkparty(kind text, nm text)
RETURNS TABLE(user_id uuid, profile_id uuid)
LANGUAGE plpgsql AS $$
DECLARE u uuid := gen_random_uuid(); p uuid := gen_random_uuid();
BEGIN
  INSERT INTO book.users(id,email) VALUES (u, u||'@example.invalid');
  INSERT INTO book.profiles(id,kind,name,county) VALUES (p,kind,nm,'Cork');
  IF kind='venue' THEN INSERT INTO book.venue_details(profile_id) VALUES (p);
  ELSE INSERT INTO book.artist_details(profile_id) VALUES (p); END IF;
  INSERT INTO book.profile_memberships(profile_id,user_id,role) VALUES (p,u,'owner');
  RETURN QUERY SELECT u,p;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.mkbooking(
  v_user uuid, v_prof uuid, a_prof uuid, d date, call_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE b uuid := gen_random_uuid();
BEGIN
  INSERT INTO book.bookings(
    id,artist_profile_id,venue_profile_id,gig_call_id,origin,event_date,
    status,terms_revision,accepted_terms_revision,created_by_user_id)
  VALUES (b,a_prof,v_prof,call_id,
    CASE WHEN call_id IS NULL THEN 'venue_request' ELSE 'gig_application' END,
    d,'accepted',1,1,v_user);
  INSERT INTO book.booking_terms(
    booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,1,(d||'T20:00:00Z')::timestamptz,(d||'T22:00:00Z')::timestamptz,
    50000,0,v_user);
  RETURN b;
END $$;

\echo '=== T1: second confirmed booking, same artist + date ==='
DO $$
DECLARE v record; a record; b1 uuid; b2 uuid; d date := current_date + 30;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','T1 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','T1 artist');
  b1 := pg_temp.mkbooking(v.user_id,v.profile_id,a.profile_id,d);
  b2 := pg_temp.mkbooking(v.user_id,v.profile_id,a.profile_id,d);
  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b1;
  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b2;
    RAISE NOTICE 'T1 FAIL: second confirmation succeeded';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T1 PASS: blocked by constraint %', SQLERRM;
  END;
END $$;

\echo '=== T2: manual availability block prevents confirmation ==='
DO $$
DECLARE v record; a record; b uuid; d date := current_date + 31;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','T2 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','T2 artist');
  b := pg_temp.mkbooking(v.user_id,v.profile_id,a.profile_id,d);
  INSERT INTO book.availability_reservations(artist_profile_id,session_date,kind)
  VALUES (a.profile_id,d,'manual');
  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b;
    RAISE NOTICE 'T2 FAIL: confirmed despite manual block';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T2 PASS: blocked by %', SQLERRM;
  END;
END $$;

\echo '=== T3: historical terms are immutable ==='
DO $$
DECLARE v record; a record; b uuid; d date := current_date + 32;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','T3 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','T3 artist');
  b := pg_temp.mkbooking(v.user_id,v.profile_id,a.profile_id,d);
  BEGIN
    UPDATE book.booking_terms SET agreed_fee_minor=100 WHERE booking_id=b AND revision=1;
    RAISE NOTICE 'T3 FAIL: terms were edited in place';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T3 PASS: %', SQLERRM;
  END;
END $$;

\echo '=== T4: booking identity and date are immutable ==='
DO $$
DECLARE v record; a record; a2 record; b uuid; d date := current_date + 33;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','T4 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','T4 artist');
  SELECT * INTO a2 FROM pg_temp.mkparty('artist','T4 artist 2');
  b := pg_temp.mkbooking(v.user_id,v.profile_id,a.profile_id,d);
  BEGIN
    UPDATE book.bookings SET artist_profile_id=a2.profile_id WHERE id=b;
    RAISE NOTICE 'T4 FAIL: artist swapped silently';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T4 PASS: %', SQLERRM;
  END;
  BEGIN
    UPDATE book.bookings SET event_date=d+1 WHERE id=b;
    RAISE NOTICE 'T4b FAIL: date moved silently';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T4b PASS: %', SQLERRM;
  END;
END $$;

\echo '=== T5: confirmation requires complete agreed terms ==='
DO $$
DECLARE v record; a record; b uuid := gen_random_uuid(); d date := current_date + 34;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','T5 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','T5 artist');
  INSERT INTO book.bookings(id,artist_profile_id,venue_profile_id,origin,event_date,
    status,terms_revision,accepted_terms_revision,created_by_user_id)
  VALUES (b,a.profile_id,v.profile_id,'venue_request',d,'accepted',1,1,v.user_id);
  -- terms with NULL fee: incomplete
  INSERT INTO book.booking_terms(booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  VALUES (b,1,(d||'T20:00:00Z')::timestamptz,(d||'T22:00:00Z')::timestamptz,
    NULL,NULL,v.user_id);
  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b;
    RAISE NOTICE 'T5 FAIL: confirmed with incomplete terms';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T5 PASS: %', SQLERRM;
  END;
END $$;

\echo '=== T6: accepted/confirmed requires matching accepted_terms_revision ==='
DO $$
DECLARE v record; a record; b uuid; d date := current_date + 35;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','T6 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','T6 artist');
  b := pg_temp.mkbooking(v.user_id,v.profile_id,a.profile_id,d);
  INSERT INTO book.booking_terms(booking_id,revision,starts_at,ends_at,
    agreed_fee_minor,agreed_deposit_minor,created_by_user_id)
  SELECT booking_id,2,starts_at,ends_at,60000,agreed_deposit_minor,v.user_id
  FROM book.booking_terms WHERE booking_id=b AND revision=1;
  BEGIN
    -- bump terms without renewed acceptance, while staying 'accepted'
    UPDATE book.bookings SET terms_revision=2, version=version+1 WHERE id=b;
    RAISE NOTICE 'T6 FAIL: terms bumped while still marked accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T6 PASS: %', SQLERRM;
  END;
END $$;

\echo '=== T7: only one confirmed booking per gig call ==='
DO $$
DECLARE v record; a1 record; a2 record; c uuid; b1 uuid; b2 uuid; d date := current_date + 36;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','T7 venue');
  SELECT * INTO a1 FROM pg_temp.mkparty('artist','T7 artist 1');
  SELECT * INTO a2 FROM pg_temp.mkparty('artist','T7 artist 2');
  INSERT INTO book.gig_calls(venue_profile_id,event_date) VALUES (v.profile_id,d) RETURNING id INTO c;
  b1 := pg_temp.mkbooking(v.user_id,v.profile_id,a1.profile_id,d,c);
  b2 := pg_temp.mkbooking(v.user_id,v.profile_id,a2.profile_id,d,c);
  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b1;
  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b2;
    RAISE NOTICE 'T7 FAIL: two acts confirmed on one gig call';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T7 PASS: blocked by %', SQLERRM;
  END;
END $$;

\echo '=== T8: one application per artist per gig call ==='
DO $$
DECLARE v record; a record; c uuid; b1 uuid; d date := current_date + 37;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','T8 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','T8 artist');
  INSERT INTO book.gig_calls(venue_profile_id,event_date) VALUES (v.profile_id,d) RETURNING id INTO c;
  b1 := pg_temp.mkbooking(v.user_id,v.profile_id,a.profile_id,d,c);
  BEGIN
    PERFORM pg_temp.mkbooking(v.user_id,v.profile_id,a.profile_id,d,c);
    RAISE NOTICE 'T8 FAIL: duplicate application created';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T8 PASS: blocked by %', SQLERRM;
  END;
END $$;

\echo '=== T9: reservation is released when a booking leaves confirmed ==='
DO $$
DECLARE v record; a record; b uuid; d date := current_date + 38; n integer;
BEGIN
  SELECT * INTO v FROM pg_temp.mkparty('venue','T9 venue');
  SELECT * INTO a FROM pg_temp.mkparty('artist','T9 artist');
  b := pg_temp.mkbooking(v.user_id,v.profile_id,a.profile_id,d);
  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b;
  SELECT count(*) INTO n FROM book.availability_reservations
    WHERE artist_profile_id=a.profile_id AND session_date=d;
  IF n <> 1 THEN RAISE NOTICE 'T9 FAIL: reservation not created (n=%)', n; RETURN; END IF;
  UPDATE book.bookings SET status='cancelled_by_venue',version=version+1 WHERE id=b;
  SELECT count(*) INTO n FROM book.availability_reservations
    WHERE artist_profile_id=a.profile_id AND session_date=d;
  IF n = 0 THEN RAISE NOTICE 'T9 PASS: reservation released on cancellation';
  ELSE RAISE NOTICE 'T9 FAIL: reservation still held after cancellation (n=%)', n; END IF;
END $$;

\echo '=== T10: a cancelled date can be re-booked by another venue ==='
DO $$
DECLARE v1 record; v2 record; a record; b1 uuid; b2 uuid; d date := current_date + 39;
BEGIN
  SELECT * INTO v1 FROM pg_temp.mkparty('venue','T10 venue 1');
  SELECT * INTO v2 FROM pg_temp.mkparty('venue','T10 venue 2');
  SELECT * INTO a FROM pg_temp.mkparty('artist','T10 artist');
  b1 := pg_temp.mkbooking(v1.user_id,v1.profile_id,a.profile_id,d);
  b2 := pg_temp.mkbooking(v2.user_id,v2.profile_id,a.profile_id,d);
  UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b1;
  UPDATE book.bookings SET status='cancelled_by_venue',version=version+1 WHERE id=b1;
  BEGIN
    UPDATE book.bookings SET status='confirmed',version=version+1,confirmed_at=now() WHERE id=b2;
    RAISE NOTICE 'T10 PASS: freed date re-booked';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'T10 FAIL: could not re-book freed date: %', SQLERRM;
  END;
END $$;
