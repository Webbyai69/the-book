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

import { HttpError, conflict } from "../db/errors.js";
import { appendEvent } from "../db/events.js";
import { hashRequest, runCommand } from "../db/command.js";
import * as v from "./validate.js";

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

/* ---------------------------------------------------------------- helpers */

/*
 * Loads a booking the acting profile actually participates in, and returns
 * which side they are. A profile that is neither participant gets 404 — never
 * a 403, which would confirm the booking exists.
 *
 * Lock order across the whole codebase is: gig call, then booking. Every
 * command that touches both must follow it or two commands can deadlock.
 */
export async function loadParticipantBooking(client, bookingId, profileId, { lockGigCall = false } = {}) {
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

/*
 * The booking row is inserted before its first terms (the FK is deferred),
 * so the BEFORE trigger that derives event_date and session_date from the
 * start time had nothing to read. Re-running it costs one no-op update.
 */
async function deriveDates(client, bookingId) {
  const result = await client.query(
    `UPDATE book.bookings SET terms_revision = terms_revision WHERE id = $1 RETURNING *`,
    [bookingId]
  );
  return result.rows[0];
}

function requireFutureStart(terms) {
  if (terms.startsAt && new Date(terms.startsAt) <= new Date()) {
    throw v.invalid("terms.startsAt", "must be in the future.");
  }
}

export function shape(booking, side) {
  return {
    booking: {
      id: booking.id,
      status: booking.status,
      version: booking.version,
      termsRevision: booking.terms_revision,
      acceptedTermsRevision: booking.accepted_terms_revision,
      eventDate: booking.event_date,
      sessionDate: booking.session_date,
      origin: booking.origin,
      gigCallId: booking.gig_call_id,
      artistProfileId: booking.artist_profile_id,
      venueProfileId: booking.venue_profile_id,
      terminalReason: booking.terminal_reason
    },
    allowedActions: allowedActions(booking, side)
  };
}

/* ------------------------------------------------------------- commands */

/*
 * Venue requests a specific artist for a date. Creates the booking and its
 * first terms revision together — the terms FK is deferrable, so the booking
 * row may reference a revision inserted later in the same transaction.
 */
export async function createBookingRequest(pool, cmd) {
  const { userId, profileId, idempotencyKey } = cmd;
  const artistProfileId = v.uuid(cmd.artistProfileId, "artistProfileId");
  const terms = v.terms(cmd.terms, { complete: true });
  requireFutureStart(terms);

  // The date the venue picked may be the night (Saturday, for a 00:30 Sunday
  // start) or the calendar date of the start; either is accepted, anything
  // else is a mistake. The stored dates are derived from startsAt.
  const night = v.sessionDate(terms.startsAt);
  const calendar = v.dublinDate(terms.startsAt);
  if (cmd.eventDate !== undefined && cmd.eventDate !== null) {
    const picked = v.date(cmd.eventDate, "eventDate");
    if (picked !== night && picked !== calendar) {
      throw v.invalid("eventDate", `does not match the start time (night of ${night}).`);
    }
  }

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: "create-booking-request",
      idempotencyKey,
      requestHash: hashRequest([artistProfileId, cmd.eventDate ?? null, terms])
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

      // Early, friendly refusal. The reservation key at confirmation is
      // still what actually prevents a double booking.
      const taken = await client.query(
        `SELECT 1 FROM book.availability_reservations
         WHERE artist_profile_id = $1 AND session_date = $2`,
        [artistProfileId, night]
      );

      if (taken.rowCount) {
        throw conflict("ARTIST_UNAVAILABLE", "The artist is not available that night.");
      }

      const created = await client.query(
        `INSERT INTO book.bookings (
           artist_profile_id, venue_profile_id, origin, event_date,
           status, terms_revision, created_by_user_id
         )
         VALUES ($1, $2, 'venue_request', $3, 'requested', 1, $4)
         RETURNING *`,
        [artistProfileId, profileId, calendar, userId]
      );

      await insertTermsRevision(client, created.rows[0].id, 1, terms, userId);
      const booking = await deriveDates(client, created.rows[0].id);
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
  const { userId, profileId, idempotencyKey } = cmd;
  const gigCallId = v.uuid(cmd.gigCallId, "gigCallId");
  const note = v.text(cmd.note, "note", { max: 2000 });

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

      // event_date is a placeholder until the venue's offer carries a
      // start time; the trigger then derives it (migration 003).
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
        { feeMinor: gigCall.budget_minor, details: note },
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
    idempotencyKey
  } = cmd;
  const terms = v.terms(cmd.terms, { complete: true });
  requireFutureStart(terms);

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
// Which side may take each action in which status is TRANSITIONS' job;
// this only names the resulting status and event.
const TERMINAL_FOR = {
  decline: { status: "declined", event: "booking.declined" },
  withdraw: { status: "withdrawn", event: "booking.withdrawn" },
  reject: { status: "not_selected", event: "gig_application.rejected" },
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

  const spec = Object.hasOwn(TERMINAL_FOR, action) ? TERMINAL_FOR[action] : null;

  if (!spec) {
    throw new HttpError(400, "UNKNOWN_ACTION", `Unsupported action: ${action}`);
  }

  const reasonText = v.text(reason, "reason", { max: 500 }) || null;

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
        [bookingId, nextStatus, reasonText ?? action]
      );

      // A cancelled confirmation frees the gig call it filled, so the venue
      // can fill the night again. The call was locked first (lock order).
      // A call whose night has already passed is closed instead.
      if (action === "cancel" && booking.gig_call_id) {
        await client.query(
          `UPDATE book.gig_calls
           SET status = CASE
                 WHEN event_date >= (now() AT TIME ZONE 'Europe/Dublin')::date THEN 'open'
                 ELSE 'cancelled'
               END,
               filled_booking_id = NULL
           WHERE id = $1 AND filled_booking_id = $2`,
          [booking.gig_call_id, bookingId]
        );
      }

      await appendEvent(
        client,
        updated.rows[0],
        { userId, profileId },
        spec.event,
        reasonText
      );

      return shape(updated.rows[0], side);
    }
  );
}
