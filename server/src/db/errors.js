/*
 * Shared database-error translation.
 *
 * Extracted from confirm-booking.js so every endpoint maps constraint
 * violations to the same HTTP responses. An endpoint that does not import
 * this will silently lose the mapping and return 500s for ordinary conflicts.
 */

export class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function conflict(code, message) {
  return new HttpError(409, code, message);
}

/*
 * Constraint names verified against PostgreSQL 16.13/16.15 by running the
 * violating statement and reading SQLERRM. Do not add a case from memory —
 * check with:
 *   SELECT conname, pg_get_constraintdef(oid, true)
 *   FROM pg_constraint WHERE conrelid = 'book.bookings'::regclass;
 */
const UNIQUE_VIOLATIONS = {
  availability_reservations_pkey: [
    "ARTIST_UNAVAILABLE",
    "The artist is no longer available on this date."
  ],
  bookings_confirmed_artist_session: [
    "ARTIST_UNAVAILABLE",
    "The artist is no longer available that night."
  ],
  bookings_confirmed_gig_call: [
    "GIG_CALL_FILLED",
    "Another booking has already filled this gig call."
  ],
  bookings_one_application: [
    "APPLICATION_ALREADY_EXISTS",
    "Your act has already applied for this gig call. Open the existing application under Bookings."
  ],
  reviews_pkey: [
    "REVIEW_ALREADY_SUBMITTED",
    "You have already reviewed this booking."
  ]
};

const FOREIGN_KEY_VIOLATIONS = {
  bookings_gig_call_session_fkey: [
    "OFFER_NOT_ON_GIG_NIGHT",
    "The start time must fall on the night this gig call advertises (sets before 06:00 count as the night before)."
  ]
};

export function translateDatabaseError(error) {
  if (error instanceof HttpError) return error;

  if (error.code === "23505") {
    const mapped = UNIQUE_VIOLATIONS[error.constraint];
    if (mapped) return conflict(mapped[0], mapped[1]);

    return conflict("CONFLICT", "This action conflicts with an existing record.");
  }

  if (error.code === "23503") {
    const mapped = FOREIGN_KEY_VIOLATIONS[error.constraint];
    if (mapped) return conflict(mapped[0], mapped[1]);

    return conflict("CONFLICT", "This action refers to a record that does not exist.");
  }

  if (error.code === "23514") {
    // RAISE EXCEPTION in our own triggers carries no constraint name and a
    // message written for people (the 06:00 rule, immutable terms). A named
    // CHECK constraint's message is a schema detail, so it stays generic.
    if (!error.constraint && error.message) {
      return conflict("INVALID_BOOKING_STATE", error.message);
    }
    return conflict(
      "INVALID_BOOKING_STATE",
      "The booking does not satisfy the required rules for this action."
    );
  }

  // Deadlock detected / serialization failure — safe to retry with the same
  // idempotency key, which is what the message tells the client to do.
  if (error.code === "40P01" || error.code === "40001") {
    return conflict(
      "RETRY_REQUIRED",
      "The booking changed concurrently. Retry using the same idempotency key."
    );
  }

  // Malformed input that reached the database: bad uuid, date, number.
  if (error.code === "22P02" || error.code === "22007" || error.code === "22008" || error.code === "22003") {
    return new HttpError(400, "INVALID_INPUT", "One of the values sent is not valid.");
  }

  return error;
}

/*
 * Idempotency claim shared by every mutating command.
 *
 * Returns { replay: <saved response> } when this exact request already
 * completed, or { replay: null } when the caller now owns the operation and
 * should proceed. The key row, the effects and the saved response all commit
 * in one transaction, so a rolled-back attempt releases the key.
 *
 * Note there is deliberately no "request still in progress" branch: INSERT ...
 * ON CONFLICT DO NOTHING blocks on an uncommitted duplicate rather than
 * returning zero rows, so by the time a row is readable it always carries a
 * response.
 */
export async function claimIdempotency(client, { userId, profileId, operation, key, requestHash }) {
  const claim = await client.query(
    `INSERT INTO book.idempotency_keys (
       user_id, profile_id, operation, key, request_hash
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING key`,
    [userId, profileId, operation, key, requestHash]
  );

  if (claim.rowCount) return { replay: null };

  const existing = await client.query(
    `SELECT request_hash, response
     FROM book.idempotency_keys
     WHERE user_id = $1 AND profile_id = $2 AND operation = $3 AND key = $4`,
    [userId, profileId, operation, key]
  );

  const saved = existing.rows[0];

  if (!saved || saved.request_hash !== requestHash) {
    throw conflict(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used for a different request."
    );
  }

  return { replay: saved.response };
}

export async function saveIdempotentResponse(client, { userId, profileId, operation, key }, response) {
  await client.query(
    `UPDATE book.idempotency_keys
     SET response = $5::jsonb
     WHERE user_id = $1 AND profile_id = $2 AND operation = $3 AND key = $4`,
    [userId, profileId, operation, key, JSON.stringify(response)]
  );
}
