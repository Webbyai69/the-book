import { createHash } from "node:crypto";

export class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function conflict(code, message) {
  return new HttpError(409, code, message);
}

function translateDatabaseError(error) {
  if (error instanceof HttpError) return error;

  if (error.code === "23505") {
    if (
      error.constraint === "availability_reservations_pkey" ||
      error.constraint === "bookings_confirmed_artist_date"
    ) {
      return conflict(
        "ARTIST_UNAVAILABLE",
        "The artist is no longer available on this date."
      );
    }

    if (error.constraint === "bookings_confirmed_gig_call") {
      return conflict(
        "GIG_CALL_FILLED",
        "Another booking has already filled this gig call."
      );
    }

    return conflict("CONFLICT", "This action conflicts with an existing record.");
  }

  if (error.code === "23514") {
    return conflict(
      "INVALID_BOOKING_STATE",
      "The booking does not satisfy the required confirmation rules."
    );
  }

  if (error.code === "40P01" || error.code === "40001") {
    return conflict(
      "RETRY_REQUIRED",
      "The booking changed concurrently. Retry using the same idempotency key."
    );
  }

  return error;
}

async function appendEvent(client, booking, actor, type, reason = null) {
  const payload = {
    bookingId: booking.id,
    version: booking.version,
    termsRevision: booking.terms_revision,
    status: booking.status,
    reason
  };

  const eventResult = await client.query(
    `INSERT INTO book.booking_events (
       booking_id, actor_user_id, actor_profile_id, type, payload
     )
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      booking.id,
      actor.userId,
      actor.profileId,
      type,
      JSON.stringify(payload)
    ]
  );

  const eventId = eventResult.rows[0].id;

  const notifications = await client.query(
    `INSERT INTO book.notifications (
       event_id, recipient_user_id, profile_id, type, payload
     )
     SELECT $1, m.user_id, m.profile_id, $2, $3::jsonb
     FROM book.profile_memberships m
     WHERE m.profile_id = ANY($4::uuid[])
     RETURNING id`,
    [
      eventId,
      type,
      JSON.stringify(payload),
      [booking.artist_profile_id, booking.venue_profile_id]
    ]
  );

  if (notifications.rows.length) {
    await client.query(
      `INSERT INTO book.outbox_events (notification_id)
       SELECT unnest($1::uuid[])`,
      [notifications.rows.map((row) => row.id)]
    );
  }
}

export async function confirmBooking(pool, command) {
  const {
    userId,
    profileId,
    bookingId,
    expectedVersion,
    expectedTermsRevision,
    idempotencyKey
  } = command;

  const operation = `confirm-booking:${bookingId}`;

  // Known fields in fixed order: object property order from the client
  // does not affect the fingerprint.
  const requestHash = createHash("sha256")
    .update(JSON.stringify([
      bookingId,
      expectedVersion,
      expectedTermsRevision
    ]))
    .digest("hex");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check before replaying an earlier response as well.
    // FOR SHARE also prevents this membership from being removed
    // while the authorised command is running.
    const membership = await client.query(
      `SELECT role
       FROM book.profile_memberships
       WHERE user_id = $1 AND profile_id = $2
       FOR SHARE`,
      [userId, profileId]
    );

    if (!membership.rowCount) {
      throw new HttpError(404, "NOT_FOUND", "Profile not found.");
    }

    // Concurrent inserts of the same key wait for one another.
    // The key, effects and response commit in the same transaction.
    const claim = await client.query(
      `INSERT INTO book.idempotency_keys (
         user_id, profile_id, operation, key, request_hash
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING key`,
      [userId, profileId, operation, idempotencyKey, requestHash]
    );

    if (!claim.rowCount) {
      const existing = await client.query(
        `SELECT request_hash, response
         FROM book.idempotency_keys
         WHERE user_id = $1
           AND profile_id = $2
           AND operation = $3
           AND key = $4`,
        [userId, profileId, operation, idempotencyKey]
      );

      const saved = existing.rows[0];

      if (!saved || saved.request_hash !== requestHash) {
        throw conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotency key was already used for a different request."
        );
      }

      if (saved.response === null) {
        throw conflict(
          "REQUEST_INCOMPLETE",
          "The earlier request has no completed response."
        );
      }

      await client.query("COMMIT");
      return saved.response;
    }

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
        confirmedAt: confirmed.confirmed_at.toISOString()
      },
      artistSettlement: {
        method: "off_platform",
        paymentVerifiedByPlatform: false
      }
    };

    await client.query(
      `UPDATE book.idempotency_keys
       SET response = $5::jsonb
       WHERE user_id = $1
         AND profile_id = $2
         AND operation = $3
         AND key = $4`,
      [
        userId,
        profileId,
        operation,
        idempotencyKey,
        JSON.stringify(response)
      ]
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
