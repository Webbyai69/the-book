/*
 * Gig calls: a venue advertises an open night, artists apply (see
 * createApplication in booking-lifecycle.js), the venue offers and confirms
 * one, and confirmation closes the rest.
 */

import { HttpError, conflict } from "../db/errors.js";
import { appendEvent } from "../db/events.js";
import { hashRequest, runCommand } from "../db/command.js";
import * as v from "./validate.js";

const OPEN_APPLICATION = ["applied", "offered", "requested", "accepted"];

export function shapeGigCall(row) {
  return {
    id: row.id,
    venueProfileId: row.venue_profile_id,
    venueName: row.venue_name,
    county: row.county,
    eventDate: row.event_date,
    status: row.status,
    budgetMinor: row.budget_minor,
    currency: row.currency,
    details: row.details,
    filledBookingId: row.filled_booking_id,
    applicationCount: row.application_count === undefined ? undefined : Number(row.application_count),
    createdAt: row.created_at
  };
}

export async function createGigCall(pool, cmd) {
  const { userId, profileId, idempotencyKey } = cmd;
  const eventDate = v.date(cmd.eventDate, "eventDate");
  const budgetMinor = v.minor(cmd.budgetMinor, "budgetMinor");
  const details = v.text(cmd.details, "details", { max: 2000 });

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: "create-gig-call",
      idempotencyKey,
      requestHash: hashRequest([eventDate, budgetMinor, details])
    },
    async (client) => {
      const venue = await client.query(
        `SELECT 1 FROM book.venue_details WHERE profile_id = $1`,
        [profileId]
      );

      if (!venue.rowCount) {
        throw new HttpError(403, "VENUE_PROFILE_REQUIRED", "Only a venue profile can post a gig call.");
      }

      const past = await client.query(
        `SELECT $1::date < (now() AT TIME ZONE 'Europe/Dublin')::date AS past`,
        [eventDate]
      );

      if (past.rows[0].past) throw v.invalid("eventDate", "cannot be in the past.");

      const created = await client.query(
        `INSERT INTO book.gig_calls (venue_profile_id, event_date, budget_minor, details)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [profileId, eventDate, budgetMinor, details]
      );

      return { gigCall: shapeGigCall(created.rows[0]) };
    }
  );
}

/*
 * Cancelling a call closes every open application on it. A call that is
 * already filled cannot be cancelled here: cancel the booking instead, which
 * reopens the call (transitionBooking), and then cancel the call.
 */
export async function cancelGigCall(pool, cmd) {
  const { userId, profileId, idempotencyKey } = cmd;
  const gigCallId = v.uuid(cmd.gigCallId, "gigCallId");

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: `cancel-gig-call:${gigCallId}`,
      idempotencyKey,
      requestHash: hashRequest([gigCallId])
    },
    async (client) => {
      // Lock order: gig call, then its bookings.
      const call = await client.query(
        `SELECT * FROM book.gig_calls WHERE id = $1 AND venue_profile_id = $2 FOR UPDATE`,
        [gigCallId, profileId]
      );

      if (!call.rowCount) throw new HttpError(404, "NOT_FOUND", "Gig call not found.");

      const gigCall = call.rows[0];

      if (gigCall.status === "filled") {
        throw conflict(
          "GIG_CALL_FILLED",
          "This gig call is filled. Cancel the booking first if you need to call off the night."
        );
      }

      if (gigCall.status === "cancelled") {
        return { gigCall: shapeGigCall(gigCall) };
      }

      const updated = await client.query(
        `UPDATE book.gig_calls SET status = 'cancelled' WHERE id = $1 RETURNING *`,
        [gigCallId]
      );

      const open = await client.query(
        `SELECT id FROM book.bookings
         WHERE gig_call_id = $1 AND status = ANY($2::text[])
         ORDER BY id
         FOR UPDATE`,
        [gigCallId, OPEN_APPLICATION]
      );

      for (const row of open.rows) {
        const closed = await client.query(
          `UPDATE book.bookings
           SET status = 'not_selected',
               terminal_reason = 'gig_call_cancelled',
               version = version + 1
           WHERE id = $1
           RETURNING *`,
          [row.id]
        );

        await appendEvent(
          client,
          closed.rows[0],
          { userId, profileId },
          "gig_application.not_selected",
          "gig_call_cancelled"
        );
      }

      return { gigCall: shapeGigCall(updated.rows[0]), closedApplications: open.rowCount };
    }
  );
}
