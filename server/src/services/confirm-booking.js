import { HttpError, conflict } from "../db/errors.js";
import { appendEvent } from "../db/events.js";
import { hashRequest, runCommand } from "../db/command.js";
import { allowedActions } from "./booking-lifecycle.js";

export { HttpError };

/*
 * Confirmation lives apart from the other transitions because it also owns
 * the availability reservation (via trigger), filling the gig call, and
 * later the platform charge.
 */
export async function confirmBooking(pool, command) {
  const {
    userId,
    profileId,
    bookingId,
    expectedVersion,
    expectedTermsRevision,
    idempotencyKey
  } = command;

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: `confirm-booking:${bookingId}`,
      idempotencyKey,
      // Known fields in fixed order: object property order from the client
      // does not affect the fingerprint.
      requestHash: hashRequest([bookingId, expectedVersion, expectedTermsRevision])
    },
    async (client) => {
      // Authorised lookup before inspecting the gig call.
      const lookup = await client.query(
        `SELECT id, artist_profile_id, venue_profile_id, gig_call_id
         FROM book.bookings
         WHERE id = $1
           AND (
             artist_profile_id = $2
             OR venue_profile_id = $2
           )`,
        [bookingId, profileId]
      );

      if (!lookup.rowCount) {
        throw new HttpError(404, "NOT_FOUND", "Booking not found.");
      }

      const identity = lookup.rows[0];

      if (identity.venue_profile_id !== profileId) {
        throw new HttpError(
          403,
          "VENUE_CONFIRMATION_REQUIRED",
          "Only the venue on this booking may confirm it."
        );
      }

      /*
       * Lock order for every future gig-call mutation:
       *   1. gig call
       *   2. booking
       *
       * Application creation, offers, acceptance and cancellation must
       * follow the same ordering.
       */
      let gigCall = null;

      if (identity.gig_call_id) {
        const result = await client.query(
          `SELECT *
           FROM book.gig_calls
           WHERE id = $1
           FOR UPDATE`,
          [identity.gig_call_id]
        );

        gigCall = result.rows[0];

        if (!gigCall || gigCall.status !== "open") {
          throw conflict(
            "GIG_CALL_CLOSED",
            "This gig call is no longer open."
          );
        }
      }

      const locked = await client.query(
        `SELECT *
         FROM book.bookings
         WHERE id = $1
         FOR UPDATE`,
        [bookingId]
      );

      const booking = locked.rows[0];

      if (
        booking.version !== expectedVersion ||
        booking.terms_revision !== expectedTermsRevision
      ) {
        throw conflict(
          "STALE_BOOKING",
          "The booking changed. Refresh it before confirming."
        );
      }

      if (
        booking.status !== "accepted" ||
        booking.accepted_terms_revision !== booking.terms_revision
      ) {
        throw conflict(
          "TERMS_NOT_ACCEPTED",
          "The artist must accept the current terms before confirmation."
        );
      }

      const termResult = await client.query(
        `SELECT
           t.*,
           t.starts_at > clock_timestamp() AS starts_in_future,
           (
             (t.starts_at AT TIME ZONE 'Europe/Dublin')::date = $3::date
           ) AS matches_booking_date
         FROM book.booking_terms t
         WHERE booking_id = $1 AND revision = $2`,
        [bookingId, booking.terms_revision, booking.event_date]
      );

      const terms = termResult.rows[0];

      if (
        !terms ||
        terms.agreed_fee_minor === null ||
        terms.agreed_deposit_minor === null ||
        !terms.starts_at ||
        !terms.ends_at ||
        !terms.matches_booking_date
      ) {
        throw conflict(
          "INCOMPLETE_TERMS",
          "Agree the fee, deposit and performance times before confirming."
        );
      }

      if (!terms.starts_in_future) {
        throw conflict(
          "BOOKING_ALREADY_STARTED",
          "A booking cannot first be confirmed after its start time."
        );
      }

      /*
       * The database trigger acquires the shared artist/date reservation.
       * A manual block or competing confirmation causes this transaction
       * to fail rather than allowing a double booking.
       */
      const updated = await client.query(
        `UPDATE book.bookings
         SET status = 'confirmed',
             version = version + 1,
             confirmed_at = now()
         WHERE id = $1
         RETURNING *`,
        [bookingId]
      );

      const confirmed = updated.rows[0];

      if (gigCall) {
        await client.query(
          `UPDATE book.gig_calls
           SET status = 'filled', filled_booking_id = $2
           WHERE id = $1`,
          [gigCall.id, bookingId]
        );

        const others = await client.query(
          `SELECT *
           FROM book.bookings
           WHERE gig_call_id = $1
             AND id <> $2
             AND status IN ('applied', 'offered', 'requested', 'accepted')
           ORDER BY id
           FOR UPDATE`,
          [gigCall.id, bookingId]
        );

        for (const other of others.rows) {
          const rejected = await client.query(
            `UPDATE book.bookings
             SET status = 'not_selected',
                 terminal_reason = 'gig_call_filled',
                 version = version + 1
             WHERE id = $1
             RETURNING *`,
            [other.id]
          );

          await appendEvent(
            client,
            rejected.rows[0],
            { userId, profileId },
            "gig_application.not_selected",
            "gig_call_filled"
          );
        }
      }

      await appendEvent(
        client,
        confirmed,
        { userId, profileId },
        "booking.confirmed"
      );

      const response = {
        booking: {
          id: confirmed.id,
          status: confirmed.status,
          version: confirmed.version,
          termsRevision: confirmed.terms_revision,
          acceptedTermsRevision: confirmed.accepted_terms_revision,
          eventDate: confirmed.event_date,
          sessionDate: confirmed.session_date,
          origin: confirmed.origin,
          gigCallId: confirmed.gig_call_id,
          artistProfileId: confirmed.artist_profile_id,
          venueProfileId: confirmed.venue_profile_id,
          terminalReason: confirmed.terminal_reason,
          confirmedAt: confirmed.confirmed_at.toISOString()
        },
        allowedActions: allowedActions(confirmed, "venue"),
        artistSettlement: {
          method: "off_platform",
          paymentVerifiedByPlatform: false
        }
      };

      return response;
    }
  );
}
