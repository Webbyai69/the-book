/*
 * Booking lifecycle: everything except confirmation, which lives in
 * confirm-booking.js because it also owns the availability reservation and
 * (later) the platform charge.
 *
 * Two origins converge on one booking record:
 *
 *   venue_request:    venue creates with proposed terms   -> requested
 *                     artist accepts                      -> accepted
 *                     venue confirms                      -> confirmed
 *
 *   gig_application:  artist applies to a gig call        -> applied
 *                     venue makes an offer                -> offered
 *                     artist accepts                      -> accepted
 *                     venue confirms                      -> confirmed
 *
 * Any material change to terms after acceptance creates a NEW immutable terms
 * revision and returns the booking to `offered` with acceptance cleared. This
 * is the "renewed artist agreement" rule — a venue cannot silently replace
 * terms the act already agreed to.
 *
 * Authorization is derived from the booking itself, never from a claimed role.
 * The client renders buttons from allowedActions(); the server independently
 * re-derives and enforces on every call.
 */

import { createHash } from "node:crypto";
import {
  HttpError,
  conflict,
  translateDatabaseError,
  claimIdempotency,
  saveIdempotentResponse
} from "../db/errors.js";

const TERMINAL = new Set([
  "declined",
  "withdrawn",
  "cancelled_by_artist",
  "cancelled_by_venue",
  "not_selected"
]);

/*
 * The state machine, as data. Each entry maps a status to the actions each
 * side may take. Keeping it declarative means allowedActions() and the
 * enforcement path cannot drift apart — they read the same table.
 */
const TRANSITIONS = {
  requested: { venue: ["revise", "withdraw", "message"], artist: ["accept", "decline", "message"] },
  applied:   { venue: ["offer", "reject", "message"],    artist: ["withdraw", "message"] },
  offered:   { venue: ["revise", "withdraw", "message"], artist: ["accept", "decline", "message"] },
  accepted:  { venue: ["confirm", "revise", "message"],  artist: ["decline", "message"] },
  confirmed: { venue: ["cancel", "message"],             artist: ["cancel", "message"] }
};

export function allowedActions(booking, side) {
  if (TERMINAL.has(booking.status)) return ["message"];
  const row = TRANSITIONS[booking.status];
  if (!row) return [];
  return row[side] || [];
}

function hashRequest(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/* ---------------------------------------------------------------- helpers */

async function requireMembership(client, userId, profileId) {
  const result = await client.query(
    `SELECT role
     FROM book.profile_memberships
     WHERE user_id = $1 AND profile_id = $2
     FOR SHARE`,
    [userId, profileId]
  );

  if (!result.rowCount) {
    // 404 rather than 403: do not confirm a profile exists to someone who
    // has no membership of it.
    throw new HttpError(404, "NOT_FOUND", "Profile not found.");
  }

  return result.rows[0].role;
}

/*
 * Loads a booking the acting profile actually participates in, and returns
 * which side they are. A profile that is neither participant gets 404 — never
 * a 403, which would confirm the booking exists.
 *
 * Lock order across the whole codebase is: gig call, then booking. Every
 * command that touches both must follow it or two commands can deadlock.
 */
async function loadParticipantBooking(client, bookingId, profileId, { lockGigCall = false } = {}) {
  const lookup = await client.query(
    `SELECT id, artist_profile_id, venue_profile_id, gig_call_id
     FROM book.bookings
     WHERE id = $1 AND (artist_profile_id = $2 OR venue_profile_id = $2)`,
    [bookingId, profileId]
  );

  if (!lookup.rowCount) {
    throw new HttpError(404, "NOT_FOUND", "Booking not found.");
  }

  const identity = lookup.rows[0];

  if (lockGigCall && identity.gig_call_id) {
    await client.query(`SELECT id FROM book.gig_calls WHERE id = $1 FOR UPDATE`, [
      identity.gig_call_id
    ]);
  }

  const locked = await client.query(`SELECT * FROM book.bookings WHERE id = $1 FOR UPDATE`, [
    bookingId
  ]);

  const booking = locked.rows[0];
  const side = booking.venue_profile_id === profileId ? "venue" : "artist";

  return { booking, side };
}

function requireAction(booking, side, action) {
  if (!allowedActions(booking, side).includes(action)) {
    throw conflict(
      "ACTION_NOT_ALLOWED",
      `This booking is ${booking.status.replace(/_/g, " ")}; you cannot ${action} it.`
    );
  }
}

function requireFresh(booking, expectedVersion, expectedTermsRevision) {
  if (
    booking.version !== expectedVersion ||
    booking.terms_revision !== expectedTermsRevision
  ) {
    throw conflict("STALE_BOOKING", "The booking changed. Refresh it and try again.");
  }
}

async function appendEvent(client, booking, actor, type, reason = null) {
  const payload = {
    bookingId: booking.id,
    version: booking.version,
    termsRevision: booking.terms_revision,
    status: booking.status,
    reason
  };

  const event = await client.query(
    `INSERT INTO book.booking_events (
       booking_id, actor_user_id, actor_profile_id, type, payload
     )
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [booking.id, actor.userId, actor.profileId, type, JSON.stringify(payload)]
  );

  const notifications = await client.query(
    `INSERT INTO book.notifications (
       event_id, recipient_user_id, profile_id, type, payload
     )
     SELECT $1, m.user_id, m.profile_id, $2, $3::jsonb
     FROM book.profile_memberships m
     WHERE m.profile_id = ANY($4::uuid[])
     RETURNING id`,
    [
      event.rows[0].id,
      type,
      JSON.stringify(payload),
      [booking.artist_profile_id, booking.venue_profile_id]
    ]
  );

  if (notifications.rows.length) {
    await client.query(
      `INSERT INTO book.outbox_events (notification_id) SELECT unnest($1::uuid[])`,
      [notifications.rows.map((r) => r.id)]
    );
  }
}

/*
 * Inserts the next immutable terms revision and returns its number. Terms are
 * never edited: a trigger rejects UPDATE and DELETE on booking_terms.
 */
async function insertTermsRevision(client, bookingId, revision, terms, userId) {
  await client.query(
    `INSERT INTO book.booking_terms (
       booking_id, revision, starts_at, ends_at, arrival_at, soundcheck_at,
       agreed_fee_minor, agreed_deposit_minor, details, created_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      bookingId,
      revision,
      terms.startsAt ?? null,
      terms.endsAt ?? null,
      terms.arrivalAt ?? null,
      terms.soundcheckAt ?? null,
      terms.feeMinor ?? null,
      terms.depositMinor ?? null,
      terms.details ?? "",
      userId
    ]
  );
  return revision;
}

function shape(booking, side) {
  return {
    booking: {
      id: booking.id,
      status: booking.status,
      version: booking.version,
      termsRevision: booking.terms_revision,
      acceptedTermsRevision: booking.accepted_terms_revision,
      eventDate: booking.event_date,
      origin: booking.origin,
      terminalReason: booking.terminal_reason
    },
    allowedActions: allowedActions(booking, side)
  };
}

/*
 * Every command shares this envelope: membership check, idempotency claim,
 * the command body, saved response, commit. Errors roll back everything
 * including the idempotency claim, so a failed attempt can be retried with
 * the same key.
 */
async function runCommand(pool, { userId, profileId, operation, idempotencyKey, requestHash }, body) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await requireMembership(client, userId, profileId);

    const { replay } = await claimIdempotency(client, {
      userId,
      profileId,
      operation,
      key: idempotencyKey,
      requestHash
    });

    if (replay) {
      await client.query("COMMIT");
      return replay;
    }

    const response = await body(client);

    await saveIdempotentResponse(
      client,
      { userId, profileId, operation, key: idempotencyKey },
      response
    );

    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    throw translateDatabaseError(error);
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------- commands */

/*
 * Venue requests a specific artist for a date. Creates the booking and its
 * first terms revision together — the terms FK is deferrable, so the booking
 * row may reference a revision inserted later in the same transaction.
 */
export async function createBookingRequest(pool, cmd) {
  const { userId, profileId, artistProfileId, eventDate, terms, idempotencyKey } = cmd;

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: "create-booking-request",
      idempotencyKey,
      requestHash: hashRequest([artistProfileId, eventDate, terms])
    },
    async (client) => {
      const venue = await client.query(
        `SELECT profile_id FROM book.venue_details WHERE profile_id = $1`,
        [profileId]
      );

      if (!venue.rowCount) {
        throw new HttpError(
          403,
          "VENUE_PROFILE_REQUIRED",
          "Only a venue profile can request an artist."
        );
      }

      const artist = await client.query(
        `SELECT profile_id FROM book.artist_details WHERE profile_id = $1`,
        [artistProfileId]
      );

      if (!artist.rowCount) {
        throw new HttpError(404, "NOT_FOUND", "Artist not found.");
      }

      const created = await client.query(
        `INSERT INTO book.bookings (
           artist_profile_id, venue_profile_id, origin, event_date,
           status, terms_revision, created_by_user_id
         )
         VALUES ($1, $2, 'venue_request', $3, 'requested', 1, $4)
         RETURNING *`,
        [artistProfileId, profileId, eventDate, userId]
      );

      const booking = created.rows[0];
      await insertTermsRevision(client, booking.id, 1, terms, userId);
      await appendEvent(client, booking, { userId, profileId }, "booking.requested");

      return shape(booking, "venue");
    }
  );
}

/*
 * Artist applies to an open gig call. The application carries the gig call's
 * own budget as a proposal only; real terms arrive when the venue offers.
 *
 * bookings_one_application (unique on gig_call_id, artist_profile_id) is the
 * final protection against a double tap, but idempotency keys should catch it
 * first and replay rather than error.
 */
export async function createApplication(pool, cmd) {
  const { userId, profileId, gigCallId, note, idempotencyKey } = cmd;

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: "create-application",
      idempotencyKey,
      requestHash: hashRequest([gigCallId, note])
    },
    async (client) => {
      const artist = await client.query(
        `SELECT profile_id FROM book.artist_details WHERE profile_id = $1`,
        [profileId]
      );

      if (!artist.rowCount) {
        throw new HttpError(
          403,
          "ARTIST_PROFILE_REQUIRED",
          "Only an artist profile can apply to a gig call."
        );
      }

      // Lock order: gig call before booking.
      const call = await client.query(
        `SELECT * FROM book.gig_calls WHERE id = $1 FOR UPDATE`,
        [gigCallId]
      );

      if (!call.rowCount) {
        throw new HttpError(404, "NOT_FOUND", "Gig call not found.");
      }

      const gigCall = call.rows[0];

      if (gigCall.status !== "open") {
        throw conflict("GIG_CALL_CLOSED", "This gig call is no longer open.");
      }

      const created = await client.query(
        `INSERT INTO book.bookings (
           artist_profile_id, venue_profile_id, gig_call_id, origin, event_date,
           status, terms_revision, created_by_user_id
         )
         VALUES ($1, $2, $3, 'gig_application', $4, 'applied', 1, $5)
         RETURNING *`,
        [profileId, gigCall.venue_profile_id, gigCallId, gigCall.event_date, userId]
      );

      const booking = created.rows[0];

      await insertTermsRevision(
        client,
        booking.id,
        1,
        { feeMinor: gigCall.budget_minor, details: note ?? "" },
        userId
      );

      await appendEvent(client, booking, { userId, profileId }, "gig_application.created");

      return shape(booking, "artist");
    }
  );
}

/*
 * Venue makes or revises an offer. This is the only path that changes money
 * or times after creation, and it always costs the artist's acceptance:
 * status returns to `offered` with accepted_terms_revision cleared.
 */
export async function makeOffer(pool, cmd) {
  const {
    userId,
    profileId,
    bookingId,
    expectedVersion,
    expectedTermsRevision,
    terms,
    idempotencyKey
  } = cmd;

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: `make-offer:${bookingId}`,
      idempotencyKey,
      requestHash: hashRequest([bookingId, expectedVersion, expectedTermsRevision, terms])
    },
    async (client) => {
      const { booking, side } = await loadParticipantBooking(client, bookingId, profileId);

      if (side !== "venue") {
        throw new HttpError(
          403,
          "VENUE_ACTION_REQUIRED",
          "Only the venue on this booking can make an offer."
        );
      }

      requireFresh(booking, expectedVersion, expectedTermsRevision);
      requireAction(booking, side, booking.status === "applied" ? "offer" : "revise");

      const nextRevision = booking.terms_revision + 1;
      await insertTermsRevision(client, bookingId, nextRevision, terms, userId);

      const updated = await client.query(
        `UPDATE book.bookings
         SET status = 'offered',
             terms_revision = $2,
             accepted_terms_revision = NULL,
             version = version + 1
         WHERE id = $1
         RETURNING *`,
        [bookingId, nextRevision]
      );

      await appendEvent(client, updated.rows[0], { userId, profileId }, "booking.offered");

      return shape(updated.rows[0], "venue");
    }
  );
}

/*
 * Artist accepts the current terms. Acceptance is pinned to the exact
 * revision, so a later revision invalidates it automatically — the CHECK
 * constraint on bookings enforces that accepted/confirmed rows always carry
 * accepted_terms_revision = terms_revision.
 */
export async function acceptBooking(pool, cmd) {
  const { userId, profileId, bookingId, expectedVersion, expectedTermsRevision, idempotencyKey } =
    cmd;

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: `accept-booking:${bookingId}`,
      idempotencyKey,
      requestHash: hashRequest([bookingId, expectedVersion, expectedTermsRevision])
    },
    async (client) => {
      const { booking, side } = await loadParticipantBooking(client, bookingId, profileId);

      if (side !== "artist") {
        throw new HttpError(
          403,
          "ARTIST_ACTION_REQUIRED",
          "Only the artist on this booking can accept it."
        );
      }

      requireFresh(booking, expectedVersion, expectedTermsRevision);
      requireAction(booking, side, "accept");

      const terms = await client.query(
        `SELECT starts_at, ends_at, agreed_fee_minor
         FROM book.booking_terms
         WHERE booking_id = $1 AND revision = $2`,
        [bookingId, booking.terms_revision]
      );

      const t = terms.rows[0];

      // An artist cannot accept a placeholder. This is what stops an
      // application's proposal-only revision 1 being accepted as if it were
      // a real offer.
      if (!t || !t.starts_at || !t.ends_at || t.agreed_fee_minor === null) {
        throw conflict(
          "INCOMPLETE_TERMS",
          "These terms are incomplete. The venue must send a full offer first."
        );
      }

      const updated = await client.query(
        `UPDATE book.bookings
         SET status = 'accepted',
             accepted_terms_revision = terms_revision,
             version = version + 1
         WHERE id = $1
         RETURNING *`,
        [bookingId]
      );

      await appendEvent(client, updated.rows[0], { userId, profileId }, "booking.accepted");

      return shape(updated.rows[0], "artist");
    }
  );
}

/*
 * Terminal transitions. `bad` in the prototype meant both "artist declined"
 * and "venue withdrew"; they are separate states here because they have
 * different downstream behaviour — a decline should surface a similar act to
 * the venue, a withdrawal should not.
 */
const TERMINAL_FOR = {
  decline: { side: "artist", status: "declined", event: "booking.declined" },
  withdraw: { venue: true, status: "withdrawn", event: "booking.withdrawn" },
  reject: { side: "venue", status: "not_selected", event: "gig_application.rejected" },
  cancel: { status: null, event: "booking.cancelled" }
};

export async function transitionBooking(pool, cmd) {
  const {
    userId,
    profileId,
    bookingId,
    action,
    reason,
    expectedVersion,
    expectedTermsRevision,
    idempotencyKey
  } = cmd;

  const spec = TERMINAL_FOR[action];

  if (!spec) {
    throw new HttpError(400, "UNKNOWN_ACTION", `Unsupported action: ${action}`);
  }

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: `transition-booking:${bookingId}`,
      idempotencyKey,
      requestHash: hashRequest([bookingId, action, expectedVersion, expectedTermsRevision])
    },
    async (client) => {
      const { booking, side } = await loadParticipantBooking(client, bookingId, profileId, {
        lockGigCall: true
      });

      requireFresh(booking, expectedVersion, expectedTermsRevision);
      requireAction(booking, side, action);

      // Cancellation records WHICH side cancelled, because the refund policy
      // depends on it: the booking fee is refunded only when the artist
      // cancels a confirmed booking.
      const nextStatus =
        action === "cancel"
          ? side === "artist"
            ? "cancelled_by_artist"
            : "cancelled_by_venue"
          : spec.status;

      const updated = await client.query(
        `UPDATE book.bookings
         SET status = $2,
             terminal_reason = $3,
             version = version + 1
         WHERE id = $1
         RETURNING *`,
        [bookingId, nextStatus, reason ?? action]
      );

      await appendEvent(
        client,
        updated.rows[0],
        { userId, profileId },
        spec.event,
        reason ?? null
      );

      return shape(updated.rows[0], side);
    }
  );
}
