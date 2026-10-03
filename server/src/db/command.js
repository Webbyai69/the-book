/*
 * Every mutating command shares this envelope: membership check, idempotency
 * claim, the command body, saved response, commit. Errors roll back
 * everything including the idempotency claim, so a failed attempt can be
 * retried with the same key.
 */

import { createHash } from "node:crypto";
import {
  HttpError,
  translateDatabaseError,
  claimIdempotency,
  saveIdempotentResponse
} from "./errors.js";

export function hashRequest(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function requireMembership(client, userId, profileId) {
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

export function requireIdempotencyKey(key) {
  if (typeof key !== "string" || key.length < 1 || key.length > 128) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Send an Idempotency-Key header (1 to 128 characters) with every change."
    );
  }
}

export async function runCommand(pool, { userId, profileId, operation, idempotencyKey, requestHash }, body) {
  requireIdempotencyKey(idempotencyKey);
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

/* A transaction with no idempotency record, for commands that have no
   profile yet (creating one) or are naturally idempotent. */
export async function inTransaction(pool, body) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw translateDatabaseError(error);
  } finally {
    client.release();
  }
}
