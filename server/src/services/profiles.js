/*
 * Profiles, manual availability blocks and notification read state.
 */

import { createHash } from "node:crypto";
import { HttpError, conflict } from "../db/errors.js";
import { hashRequest, runCommand, inTransaction, requireMembership, requireIdempotencyKey } from "../db/command.js";
import * as v from "./validate.js";

const MAX_PROFILES_PER_USER = 10;

/*
 * Creating a profile happens before there is a profile to hang an
 * idempotency record on, so the key itself names the new profile: the same
 * user retrying with the same key lands on the same id and gets the profile
 * back instead of a duplicate.
 */
function profileIdFor(userId, key) {
  const h = createHash("sha256").update(`profile:${userId}:${key}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function artistFields(input) {
  return {
    actType: input.actType === undefined ? undefined : v.oneOf(input.actType, "actType", v.ACT_TYPES),
    genres:
      input.genres === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(input.genres) || input.genres.length > v.GENRES.length) {
              throw v.invalid("genres", `must be a list drawn from: ${v.GENRES.join(", ")}.`);
            }
            input.genres.forEach((g) => v.oneOf(g, "genres", v.GENRES));
            return [...new Set(input.genres)];
          })(),
    statedFeeMinor: input.statedFeeMinor === undefined ? undefined : v.minor(input.statedFeeMinor, "statedFeeMinor")
  };
}

export async function createProfile(pool, cmd) {
  const { userId, idempotencyKey } = cmd;
  requireIdempotencyKey(idempotencyKey);

  const kind = v.oneOf(cmd.kind, "kind", ["artist", "venue"]);
  const name = v.text(cmd.name, "name", { min: 1, max: 160, required: true });
  const county = v.oneOf(cmd.county, "county", v.COUNTIES);
  const bio = v.text(cmd.bio, "bio", { max: 4000 });
  const artist = kind === "artist" ? artistFields(cmd) : {};
  const profileId = profileIdFor(userId, idempotencyKey);

  return inTransaction(pool, async (client) => {
    const existing = await client.query(
      `SELECT p.id FROM book.profiles p
       JOIN book.profile_memberships m ON m.profile_id = p.id AND m.user_id = $2
       WHERE p.id = $1`,
      [profileId, userId]
    );

    if (existing.rowCount) return getProfile(client, profileId);

    // Serialise one user's profile creations so the cap below holds.
    await client.query(`SELECT 1 FROM book.users WHERE id = $1 FOR UPDATE`, [userId]);

    const count = await client.query(
      `SELECT count(*)::int AS n FROM book.profile_memberships WHERE user_id = $1`,
      [userId]
    );

    if (count.rows[0].n >= MAX_PROFILES_PER_USER) {
      throw conflict("PROFILE_LIMIT", `An account can hold at most ${MAX_PROFILES_PER_USER} profiles.`);
    }

    await client.query(
      `INSERT INTO book.profiles (id, kind, name, county, bio, published_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [profileId, kind, name, county, bio]
    );

    if (kind === "artist") {
      await client.query(
        `INSERT INTO book.artist_details (profile_id, act_type, genres, stated_fee_minor)
         VALUES ($1, coalesce($2, 'Band'), coalesce($3::text[], '{}'), $4)`,
        [profileId, artist.actType ?? null, artist.genres ?? null, artist.statedFeeMinor ?? null]
      );
    } else {
      await client.query(`INSERT INTO book.venue_details (profile_id) VALUES ($1)`, [profileId]);
    }

    await client.query(
      `INSERT INTO book.profile_memberships (profile_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [profileId, userId]
    );

    return getProfile(client, profileId);
  });
}

export async function updateProfile(pool, cmd) {
  const { userId, profileId, idempotencyKey } = cmd;
  const patch = {
    name: cmd.name === undefined ? undefined : v.text(cmd.name, "name", { min: 1, max: 160, required: true }),
    county: cmd.county === undefined ? undefined : v.oneOf(cmd.county, "county", v.COUNTIES),
    bio: cmd.bio === undefined ? undefined : v.text(cmd.bio, "bio", { max: 4000 }),
    published: cmd.published === undefined ? undefined : cmd.published === true,
    ...artistFields(cmd)
  };

  return runCommand(
    pool,
    {
      userId,
      profileId,
      operation: "update-profile",
      idempotencyKey,
      requestHash: hashRequest(patch)
    },
    async (client) => {
      await client.query(
        `UPDATE book.profiles
         SET name = coalesce($2, name),
             county = coalesce($3, county),
             bio = coalesce($4, bio),
             published_at = CASE
               WHEN $5::boolean IS NULL THEN published_at
               WHEN $5 THEN coalesce(published_at, now())
               ELSE NULL
             END
         WHERE id = $1`,
        [profileId, patch.name ?? null, patch.county ?? null, patch.bio ?? null, patch.published ?? null]
      );

      const isArtist = (await client.query(
        `SELECT 1 FROM book.artist_details WHERE profile_id = $1`, [profileId]
      )).rowCount;

      if (isArtist) {
        await client.query(
          `UPDATE book.artist_details
           SET act_type = coalesce($2, act_type),
               genres = coalesce($3::text[], genres),
               stated_fee_minor = CASE WHEN $5 THEN $4 ELSE stated_fee_minor END
           WHERE profile_id = $1`,
          [profileId, patch.actType ?? null, patch.genres ?? null, patch.statedFeeMinor ?? null,
           patch.statedFeeMinor !== undefined]
        );
      } else if (patch.actType !== undefined || patch.genres !== undefined || patch.statedFeeMinor !== undefined) {
        throw v.invalid("profile", "act type, genres and fee apply to artist profiles only.");
      }

      return getProfile(client, profileId);
    }
  );
}

export async function getProfile(client, profileId) {
  const result = await client.query(
    `SELECT p.id, p.kind, p.name, p.county, p.bio, p.published_at, p.created_at,
            a.act_type, a.genres, a.stated_fee_minor
     FROM book.profiles p
     LEFT JOIN book.artist_details a ON a.profile_id = p.id
     WHERE p.id = $1`,
    [profileId]
  );

  if (!result.rowCount) throw new HttpError(404, "NOT_FOUND", "Profile not found.");
  return { profile: shapeProfile(result.rows[0]) };
}

export function shapeProfile(row) {
  const profile = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    county: row.county,
    bio: row.bio,
    published: row.published_at !== null,
    role: row.role
  };

  if (row.kind === "artist") {
    profile.actType = row.act_type;
    profile.genres = row.genres;
    profile.statedFeeMinor = row.stated_fee_minor;
  }

  if (row.review_count !== undefined) {
    profile.reviewCount = Number(row.review_count);
    profile.rating = row.rating === null ? null : Number(row.rating);
  }

  return profile;
}

/* ------------------------------------------------- availability blocks */

async function requireArtist(client, profileId) {
  const artist = await client.query(`SELECT 1 FROM book.artist_details WHERE profile_id = $1`, [profileId]);
  if (!artist.rowCount) {
    throw new HttpError(403, "ARTIST_PROFILE_REQUIRED", "Only an artist profile has availability.");
  }
}

/* Blocking a night is naturally idempotent: blocking it twice is fine. */
export async function blockNight(pool, { userId, profileId, date }) {
  const night = v.date(date, "date");

  return inTransaction(pool, async (client) => {
    await requireMembership(client, userId, profileId);
    await requireArtist(client, profileId);

    const inserted = await client.query(
      `INSERT INTO book.availability_reservations (artist_profile_id, session_date, kind)
       VALUES ($1, $2, 'manual')
       ON CONFLICT (artist_profile_id, session_date) DO NOTHING
       RETURNING kind`,
      [profileId, night]
    );

    if (!inserted.rowCount) {
      const existing = await client.query(
        `SELECT kind FROM book.availability_reservations
         WHERE artist_profile_id = $1 AND session_date = $2`,
        [profileId, night]
      );
      if (existing.rows[0]?.kind === "booking") {
        throw conflict("NIGHT_BOOKED", "You already have a confirmed booking that night.");
      }
    }

    return { block: { date: night, kind: "manual" } };
  });
}

export async function unblockNight(pool, { userId, profileId, date }) {
  const night = v.date(date, "date");

  return inTransaction(pool, async (client) => {
    await requireMembership(client, userId, profileId);
    await requireArtist(client, profileId);

    // Only manual blocks: a booking's reservation is released by cancelling it.
    await client.query(
      `DELETE FROM book.availability_reservations
       WHERE artist_profile_id = $1 AND session_date = $2 AND kind = 'manual'`,
      [profileId, night]
    );

    return { unblocked: night };
  });
}

/* ------------------------------------------------------ notifications */

export async function markNotificationRead(pool, { userId, profileId, notificationId }) {
  const id = notificationId === "all" ? null : v.uuid(notificationId, "notificationId");

  return inTransaction(pool, async (client) => {
    await requireMembership(client, userId, profileId);

    const result = await client.query(
      `UPDATE book.notifications
       SET read_at = coalesce(read_at, now())
       WHERE recipient_user_id = $1 AND profile_id = $2 AND ($3::uuid IS NULL OR id = $3)
       RETURNING id`,
      [userId, profileId, id]
    );

    if (id && !result.rowCount) throw new HttpError(404, "NOT_FOUND", "Notification not found.");
    return { read: result.rowCount };
  });
}
