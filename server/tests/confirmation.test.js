import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  confirmBooking
} from "../src/services/confirm-booking.js";

const { Pool, types } = pg;

types.setTypeParser(1082, (value) => value);

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 10
});

const eventDate = new Date(
  Date.now() + 30 * 24 * 60 * 60 * 1000
).toISOString().slice(0, 10);

before(async () => {
  const result = await pool.query("SELECT current_database() AS name");

  if (!result.rows[0].name.endsWith("_test")) {
    throw new Error("Integration tests require a database ending in _test.");
  }

  // Migration must already have been applied to the test database.
  await pool.query("SELECT 1 FROM book.bookings LIMIT 1");
});

after(async () => {
  await pool.end();
});

async function party(kind) {
  const userId = randomUUID();
  const profileId = randomUUID();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO book.users (id, email)
       VALUES ($1, $2)`,
      [userId, `${userId}@example.invalid`]
    );

    await client.query(
      `INSERT INTO book.profiles (id, kind, name, county)
       VALUES ($1, $2, $3, 'Cork')`,
      [profileId, kind, `Integration test ${kind}`]
    );

    // Identifiers here come only from this test's fixed branch.
    if (kind === "venue") {
      await client.query(
        `INSERT INTO book.venue_details (profile_id)
         VALUES ($1)`,
        [profileId]
      );
    } else {
      await client.query(
        `INSERT INTO book.artist_details (profile_id)
         VALUES ($1)`,
        [profileId]
      );
    }

    await client.query(
      `INSERT INTO book.profile_memberships (
         profile_id, user_id, role
       ) VALUES ($1, $2, 'owner')`,
      [profileId, userId]
    );

    await client.query("COMMIT");

    return { userId, profileId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function gigCall(venue) {
  const result = await pool.query(
    `INSERT INTO book.gig_calls (venue_profile_id, event_date)
     VALUES ($1, $2)
     RETURNING id`,
    [venue.profileId, eventDate]
  );

  return result.rows[0].id;
}

/*
 * Accepted bookings here are fixtures, not a substitute for the
 * request/offer/acceptance endpoints that remain to be implemented.
 */
async function acceptedBooking(venue, artist, callId = null) {
  const bookingId = randomUUID();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO book.bookings (
         id, artist_profile_id, venue_profile_id,
         gig_call_id, origin, event_date,
         status, terms_revision, accepted_terms_revision,
         created_by_user_id
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         'accepted', 1, 1, $7
       )`,
      [
        bookingId,
        artist.profileId,
        venue.profileId,
        callId,
        callId ? "gig_application" : "venue_request",
        eventDate,
        venue.userId
      ]
    );

    await client.query(
      `INSERT INTO book.booking_terms (
         booking_id, revision,
         starts_at, ends_at,
         agreed_fee_minor, agreed_deposit_minor,
         created_by_user_id
       )
       VALUES ($1, 1, $2, $3, 50000, 0, $4)`,
      [
        bookingId,
        `${eventDate}T20:00:00Z`,
        `${eventDate}T22:00:00Z`,
        venue.userId
      ]
    );

    await client.query("COMMIT");
    return bookingId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function command(venue, bookingId, overrides = {}) {
  return {
    userId: venue.userId,
    profileId: venue.profileId,
    bookingId,
    expectedVersion: 1,
    expectedTermsRevision: 1,
    idempotencyKey: randomUUID(),
    ...overrides
  };
}

test("two simultaneous confirmations cannot double-book an artist", async () => {
  const venue = await party("venue");
  const artist = await party("artist");

  const first = await acceptedBooking(venue, artist);
  const second = await acceptedBooking(venue, artist);

  const results = await Promise.allSettled([
    confirmBooking(pool, command(venue, first)),
    confirmBooking(pool, command(venue, second))
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1
  );

  const rejected = results.find((result) => result.status === "rejected");

  assert.equal(rejected.reason.statusCode, 409);
  assert.equal(rejected.reason.code, "ARTIST_UNAVAILABLE");

  const reservations = await pool.query(
    `SELECT *
     FROM book.availability_reservations
     WHERE artist_profile_id = $1 AND event_date = $2`,
    [artist.profileId, eventDate]
  );

  assert.equal(reservations.rowCount, 1);
});

test("manual availability blocks prevent confirmation", async () => {
  const venue = await party("venue");
  const artist = await party("artist");
  const bookingId = await acceptedBooking(venue, artist);

  await pool.query(
    `INSERT INTO book.availability_reservations (
       artist_profile_id, event_date, kind
     )
     VALUES ($1, $2, 'manual')`,
    [artist.profileId, eventDate]
  );

  await assert.rejects(
    confirmBooking(pool, command(venue, bookingId)),
    (error) =>
      error.statusCode === 409 &&
      error.code === "ARTIST_UNAVAILABLE"
  );

  const booking = await pool.query(
    "SELECT status FROM book.bookings WHERE id = $1",
    [bookingId]
  );

  assert.equal(booking.rows[0].status, "accepted");
});

test("retrying confirmation returns the original result without duplicate events", async () => {
  const venue = await party("venue");
  const artist = await party("artist");
  const bookingId = await acceptedBooking(venue, artist);
  const request = command(venue, bookingId);

  const first = await confirmBooking(pool, request);
  const second = await confirmBooking(pool, request);

  assert.deepEqual(second, first);

  const events = await pool.query(
    `SELECT count(*)::integer AS count
     FROM book.booking_events
     WHERE booking_id = $1 AND type = 'booking.confirmed'`,
    [bookingId]
  );

  assert.equal(events.rows[0].count, 1);
});

test("an unrelated profile cannot confirm another venue's booking", async () => {
  const venue = await party("venue");
  const outsider = await party("venue");
  const artist = await party("artist");
  const bookingId = await acceptedBooking(venue, artist);

  await assert.rejects(
    confirmBooking(pool, command(outsider, bookingId)),
    (error) => error.statusCode === 404
  );
});

test("historical terms cannot be edited in place", async () => {
  const venue = await party("venue");
  const artist = await party("artist");
  const bookingId = await acceptedBooking(venue, artist);

  await assert.rejects(
    pool.query(
      `UPDATE book.booking_terms
       SET agreed_fee_minor = 100
       WHERE booking_id = $1 AND revision = 1`,
      [bookingId]
    ),
    (error) => error.code === "23514"
  );
});

test("a revised offer requires renewed artist acceptance", async () => {
  const venue = await party("venue");
  const artist = await party("artist");
  const bookingId = await acceptedBooking(venue, artist);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO book.booking_terms (
         booking_id, revision, starts_at, ends_at,
         agreed_fee_minor, agreed_deposit_minor,
         created_by_user_id
       )
       SELECT
         booking_id, 2, starts_at, ends_at,
         60000, agreed_deposit_minor, $2
       FROM book.booking_terms
       WHERE booking_id = $1 AND revision = 1`,
      [bookingId, venue.userId]
    );

    await client.query(
      `UPDATE book.bookings
       SET status = 'requested',
           version = 2,
           terms_revision = 2,
           accepted_terms_revision = NULL
       WHERE id = $1`,
      [bookingId]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await assert.rejects(
    confirmBooking(pool, command(venue, bookingId, {
      expectedVersion: 2,
      expectedTermsRevision: 2
    })),
    (error) =>
      error.statusCode === 409 &&
      error.code === "TERMS_NOT_ACCEPTED"
  );
});

test("only one applicant can fill a gig call", async () => {
  const venue = await party("venue");
  const firstArtist = await party("artist");
  const secondArtist = await party("artist");
  const callId = await gigCall(venue);

  const firstBooking = await acceptedBooking(venue, firstArtist, callId);
  const secondBooking = await acceptedBooking(venue, secondArtist, callId);

  const results = await Promise.allSettled([
    confirmBooking(pool, command(venue, firstBooking)),
    confirmBooking(pool, command(venue, secondBooking))
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1
  );

  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.statusCode, 409);

  const call = await pool.query(
    "SELECT status, filled_booking_id FROM book.gig_calls WHERE id = $1",
    [callId]
  );

  assert.equal(call.rows[0].status, "filled");
  assert.ok(call.rows[0].filled_booking_id);

  const bookings = await pool.query(
    `SELECT status, terminal_reason
     FROM book.bookings
     WHERE gig_call_id = $1`,
    [callId]
  );

  assert.equal(
    bookings.rows.filter((row) => row.status === "confirmed").length,
    1
  );

  const unsuccessful = bookings.rows.find(
    (row) => row.status === "not_selected"
  );

  assert.equal(unsuccessful.terminal_reason, "gig_call_filled");
});
