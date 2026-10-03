/*
 * What the two sides say about a booking: its message thread, and the
 * reviews they leave once the gig has happened.
 */

import { HttpError, conflict } from "../db/errors.js";
import { appendEvent } from "../db/events.js";
import { hashRequest, runCommand, requireMembership } from "../db/command.js";
import { loadParticipantBooking } from "./booking-lifecycle.js";
import * as v from "./validate.js";

/* Messages stay open in every status, including terminal ones: a declined
   booking is often exactly when the two sides need to talk. */
export async function sendMessage(pool, cmd) {
  const { userId, profileId, idempotencyKey } = cmd;
  const bookingId = v.uuid(cmd.bookingId, "bookingId");
  const body = v.text(cmd.text, "text", { min: 1, max: 4000, required: true });

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: `send-message:${bookingId}`,
      idempotencyKey,
      requestHash: hashRequest([bookingId, body])
    },
    async (client) => {
      const { booking } = await loadParticipantBooking(client, bookingId, profileId);

      const inserted = await client.query(
        `INSERT INTO book.booking_messages (booking_id, author_user_id, author_profile_id, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, author_profile_id, body, created_at`,
        [bookingId, userId, profileId, body]
      );

      const message = inserted.rows[0];

      await appendEvent(client, booking, { userId, profileId }, "booking.message", null, {
        messageId: message.id
      });

      return { message: shapeMessage(message, profileId) };
    }
  );
}

export async function listMessages(pool, { userId, profileId, bookingId }) {
  bookingId = v.uuid(bookingId, "bookingId");
  const client = await pool.connect();

  try {
    await requireMembership(client, userId, profileId);

    const participant = await client.query(
      `SELECT 1 FROM book.bookings
       WHERE id = $1 AND (artist_profile_id = $2 OR venue_profile_id = $2)`,
      [bookingId, profileId]
    );

    if (!participant.rowCount) throw new HttpError(404, "NOT_FOUND", "Booking not found.");

    const rows = await client.query(
      `SELECT m.id, m.author_profile_id, m.body, m.created_at, p.name AS author_name
       FROM book.booking_messages m
       JOIN book.profiles p ON p.id = m.author_profile_id
       WHERE m.booking_id = $1
       ORDER BY m.created_at, m.id`,
      [bookingId]
    );

    return { bookingId, messages: rows.rows.map((m) => shapeMessage(m, profileId)) };
  } finally {
    client.release();
  }
}

function shapeMessage(m, viewerProfileId) {
  return {
    id: m.id,
    authorProfileId: m.author_profile_id,
    authorName: m.author_name,
    mine: m.author_profile_id === viewerProfileId,
    text: m.body,
    createdAt: m.created_at
  };
}

/* Each side reviews the other once, after a confirmed gig has finished. */
export async function submitReview(pool, cmd) {
  const { userId, profileId, idempotencyKey } = cmd;
  const bookingId = v.uuid(cmd.bookingId, "bookingId");
  const score = cmd.score;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw v.invalid("score", "must be a whole number from 1 to 5.");
  }
  const note = v.text(cmd.note, "note", { max: 2000 });

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: `submit-review:${bookingId}`,
      idempotencyKey,
      requestHash: hashRequest([bookingId, score, note])
    },
    async (client) => {
      const { booking, side } = await loadParticipantBooking(client, bookingId, profileId);

      const finished = await client.query(
        `SELECT t.ends_at < now() AS finished
         FROM book.booking_terms t
         WHERE t.booking_id = $1 AND t.revision = $2`,
        [bookingId, booking.terms_revision]
      );

      if (booking.status !== "confirmed" || !finished.rows[0]?.finished) {
        throw conflict("REVIEW_NOT_OPEN", "Reviews open once a confirmed gig has finished.");
      }

      const subject = side === "venue" ? booking.artist_profile_id : booking.venue_profile_id;

      await client.query(
        `INSERT INTO book.reviews (
           booking_id, author_profile_id, subject_profile_id, author_user_id, score, note
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [bookingId, profileId, subject, userId, score, note]
      );

      await appendEvent(client, booking, { userId, profileId }, "booking.reviewed", null, { score });

      return { review: { bookingId, authorProfileId: profileId, subjectProfileId: subject, score, note } };
    }
  );
}
