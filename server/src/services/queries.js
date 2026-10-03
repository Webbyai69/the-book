/*
 * Read side. Every read is scoped to a profile the signed-in user is a
 * member of, except discovery, which only shows published profiles.
 */

import { requireMembership } from "../db/command.js";
import { HttpError } from "../db/errors.js";
import { allowedActions } from "./booking-lifecycle.js";
import { shapeGigCall } from "./gig-calls.js";
import { shapeProfile } from "./profiles.js";
import * as v from "./validate.js";

const PENDING = new Set(["requested", "applied", "offered", "accepted"]);

async function withClient(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function listMyProfiles(pool, { userId }) {
  const result = await pool.query(
    `SELECT p.id, p.kind, p.name, p.county, p.bio, p.published_at, m.role,
            a.act_type, a.genres, a.stated_fee_minor
     FROM book.profile_memberships m
     JOIN book.profiles p ON p.id = m.profile_id
     LEFT JOIN book.artist_details a ON a.profile_id = p.id
     WHERE m.user_id = $1
     ORDER BY p.created_at`,
    [userId]
  );
  return { profiles: result.rows.map(shapeProfile) };
}

/* Pending, Upcoming, Completed, Cancelled: the four tabs in the prototype. */
function bucketFor(row) {
  if (PENDING.has(row.status)) return "pending";
  if (row.status === "confirmed") return row.ends_at && row.ends_at < new Date() ? "completed" : "upcoming";
  return "cancelled";
}

function shapeBookingRow(row, profileId) {
  const side = row.venue_profile_id === profileId ? "venue" : "artist";
  return {
    id: row.id,
    status: row.status,
    bucket: bucketFor(row),
    side,
    version: row.version,
    termsRevision: row.terms_revision,
    acceptedTermsRevision: row.accepted_terms_revision,
    eventDate: row.event_date,
    sessionDate: row.session_date,
    origin: row.origin,
    gigCallId: row.gig_call_id,
    terminalReason: row.terminal_reason,
    confirmedAt: row.confirmed_at,
    artist: { id: row.artist_profile_id, name: row.artist_name, county: row.artist_county },
    venue: { id: row.venue_profile_id, name: row.venue_name, county: row.venue_county },
    terms: {
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      arrivalAt: row.arrival_at,
      soundcheckAt: row.soundcheck_at,
      feeMinor: row.agreed_fee_minor,
      depositMinor: row.agreed_deposit_minor,
      balanceMinor:
        row.agreed_fee_minor === null ? null : row.agreed_fee_minor - (row.agreed_deposit_minor ?? 0),
      currency: row.currency,
      details: row.details
    },
    messageCount: Number(row.message_count),
    reviewedByMe: row.reviewed_by_me,
    canReview: row.status === "confirmed" && bucketFor(row) === "completed" && !row.reviewed_by_me,
    allowedActions: allowedActions(row, side)
  };
}

const BOOKING_SELECT = `
  SELECT b.*, t.starts_at, t.ends_at, t.arrival_at, t.soundcheck_at,
         t.agreed_fee_minor, t.agreed_deposit_minor, t.currency, t.details,
         ap.name AS artist_name, ap.county AS artist_county,
         vp.name AS venue_name, vp.county AS venue_county,
         (SELECT count(*) FROM book.booking_messages m WHERE m.booking_id = b.id) AS message_count,
         EXISTS (SELECT 1 FROM book.reviews r
                 WHERE r.booking_id = b.id AND r.author_profile_id = $1) AS reviewed_by_me
  FROM book.bookings b
  JOIN book.booking_terms t ON t.booking_id = b.id AND t.revision = b.terms_revision
  JOIN book.profiles ap ON ap.id = b.artist_profile_id
  JOIN book.profiles vp ON vp.id = b.venue_profile_id`;

async function bookingsFor(client, profileId) {
  const result = await client.query(
    `${BOOKING_SELECT}
     WHERE b.artist_profile_id = $1 OR b.venue_profile_id = $1
     ORDER BY coalesce(t.starts_at, b.event_date::timestamptz) DESC, b.id
     LIMIT 500`,
    [profileId]
  );
  return result.rows.map((row) => shapeBookingRow(row, profileId));
}

export async function listBookings(pool, { userId, profileId }) {
  return withClient(pool, async (client) => {
    await requireMembership(client, userId, profileId);
    return { bookings: await bookingsFor(client, profileId) };
  });
}

export async function getBooking(pool, { userId, profileId, bookingId }) {
  bookingId = v.uuid(bookingId, "bookingId");
  return withClient(pool, async (client) => {
    await requireMembership(client, userId, profileId);
    const result = await client.query(
      `${BOOKING_SELECT}
       WHERE b.id = $2 AND (b.artist_profile_id = $1 OR b.venue_profile_id = $1)`,
      [profileId, bookingId]
    );
    if (!result.rowCount) throw new HttpError(404, "NOT_FOUND", "Booking not found.");
    return { booking: shapeBookingRow(result.rows[0], profileId) };
  });
}

/*
 * Published artists, filtered. With a date, artists holding a reservation
 * (booking or manual block) on that night are left out -- the server is the
 * only place that can know who is free.
 */
export async function discoverArtists(pool, filters = {}) {
  const county = filters.county ? v.oneOf(filters.county, "county", v.COUNTIES) : null;
  const actType = filters.actType ? v.oneOf(filters.actType, "actType", v.ACT_TYPES) : null;
  const genre = filters.genre ? v.oneOf(filters.genre, "genre", v.GENRES) : null;
  const night = filters.date ? v.date(filters.date, "date") : null;

  const result = await pool.query(
    `SELECT p.id, p.kind, p.name, p.county, p.bio, p.published_at,
            a.act_type, a.genres, a.stated_fee_minor,
            count(r.score) AS review_count,
            round(avg(r.score), 1) AS rating
     FROM book.profiles p
     JOIN book.artist_details a ON a.profile_id = p.id
     LEFT JOIN book.reviews r ON r.subject_profile_id = p.id
     WHERE p.published_at IS NOT NULL
       AND ($1::text IS NULL OR p.county = $1)
       AND ($2::text IS NULL OR a.act_type = $2)
       AND ($3::text IS NULL OR $3 = ANY(a.genres))
       AND ($4::date IS NULL OR NOT EXISTS (
             SELECT 1 FROM book.availability_reservations ar
             WHERE ar.artist_profile_id = p.id AND ar.session_date = $4))
     GROUP BY p.id, a.profile_id
     ORDER BY p.name, p.id
     LIMIT 200`,
    [county, actType, genre, night]
  );

  return { artists: result.rows.map(shapeProfile), date: night };
}

/* Open calls from today on; a venue also sees all of its own calls. */
export async function listGigCalls(pool, { profileId = null, county = null } = {}) {
  county = county ? v.oneOf(county, "county", v.COUNTIES) : null;

  const result = await pool.query(
    `SELECT g.*, p.name AS venue_name, p.county,
            CASE WHEN g.venue_profile_id = $1 THEN
              (SELECT count(*) FROM book.bookings b WHERE b.gig_call_id = g.id)
            END AS application_count,
            EXISTS (SELECT 1 FROM book.bookings b
                    WHERE b.gig_call_id = g.id AND b.artist_profile_id = $1) AS applied
     FROM book.gig_calls g
     JOIN book.profiles p ON p.id = g.venue_profile_id
     WHERE (g.venue_profile_id = $1)
        OR (g.status = 'open'
            AND g.event_date >= (now() AT TIME ZONE 'Europe/Dublin')::date
            AND ($2::text IS NULL OR p.county = $2))
     ORDER BY g.event_date, g.id
     LIMIT 300`,
    [profileId, county]
  );

  return {
    gigCalls: result.rows.map((row) => {
      const call = shapeGigCall(row);
      if (row.application_count === null) delete call.applicationCount;
      call.mine = row.venue_profile_id === profileId;
      call.applied = row.applied;
      return call;
    })
  };
}

export async function listNotifications(pool, { userId, profileId }) {
  return withClient(pool, async (client) => {
    await requireMembership(client, userId, profileId);
    return notificationsFor(client, userId, profileId);
  });
}

async function notificationsFor(client, userId, profileId) {
  const result = await client.query(
    `SELECT id, type, payload, read_at, created_at
     FROM book.notifications
     WHERE recipient_user_id = $1 AND profile_id = $2
     ORDER BY created_at DESC, id
     LIMIT 50`,
    [userId, profileId]
  );
  const unread = await client.query(
    `SELECT count(*)::int AS n FROM book.notifications
     WHERE recipient_user_id = $1 AND profile_id = $2 AND read_at IS NULL`,
    [userId, profileId]
  );
  return {
    notifications: result.rows.map((n) => ({
      id: n.id,
      type: n.type,
      bookingId: n.payload.bookingId,
      status: n.payload.status,
      reason: n.payload.reason,
      read: n.read_at !== null,
      createdAt: n.created_at
    })),
    unreadCount: unread.rows[0].n
  };
}

/* Nights an artist cannot take: manual blocks and confirmed bookings. */
async function reservationsFor(client, profileId) {
  const result = await client.query(
    `SELECT session_date, kind, booking_id FROM book.availability_reservations
     WHERE artist_profile_id = $1
       AND session_date >= (now() AT TIME ZONE 'Europe/Dublin')::date - 1
     ORDER BY session_date`,
    [profileId]
  );
  return result.rows.map((r) => ({ date: r.session_date, kind: r.kind, bookingId: r.booking_id }));
}

/*
 * Everything the app shell needs in one authorised call; the shape matches
 * TheBookApi.hydrate() in api.js.
 */
export async function bootstrap(pool, { userId, profileId }) {
  return withClient(pool, async (client) => {
    await requireMembership(client, userId, profileId);

    const me = await client.query(
      `SELECT p.id, p.kind, p.name, p.county, p.bio, p.published_at, m.role,
              a.act_type, a.genres, a.stated_fee_minor
       FROM book.profiles p
       JOIN book.profile_memberships m ON m.profile_id = p.id AND m.user_id = $2
       LEFT JOIN book.artist_details a ON a.profile_id = p.id
       WHERE p.id = $1`,
      [profileId, userId]
    );

    const profile = shapeProfile(me.rows[0]);
    const [bookings, notes, profiles, artists, gigCalls] = await Promise.all([
      bookingsFor(client, profileId),
      notificationsFor(client, userId, profileId),
      listMyProfiles(client, { userId }),
      discoverArtists(client, {}),
      listGigCalls(client, { profileId })
    ]);

    return {
      profile,
      profiles: profiles.profiles,
      bookings,
      artists: artists.artists.filter((a) => a.id !== profileId),
      gigCalls: gigCalls.gigCalls,
      threads: [],
      notifications: notes.notifications,
      unreadCount: notes.unreadCount,
      availability: profile.kind === "artist" ? await reservationsFor(client, profileId) : []
    };
  });
}
