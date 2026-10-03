/*
 * End-to-end tests through the HTTP handler: real routing, real token
 * verification (HS256 with a test secret), real database. Requests are
 * handed straight to the fetch-style handler, so no port is opened.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

import { createApp } from "../src/http/app.js";
import { createTokenVerifier } from "../src/http/auth.js";
import { createPool } from "../src/db/pool.js";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required.");

const SECRET = "test-secret-at-least-32-characters-long!!";
const pool = createPool(process.env.TEST_DATABASE_URL);
/*
 * API_TEST_URL runs the same tests against a running server instead, e.g.
 * `wrangler dev` with SUPABASE_JWT_SECRET and ALLOWED_ORIGINS set to the
 * values above and DATABASE_URL pointing at the test database.
 */
const handle = process.env.API_TEST_URL
  ? (request) => {
      const url = new URL(request.url);
      return fetch(new URL(url.pathname + url.search, process.env.API_TEST_URL), request);
    }
  : createApp({
      pool,
      verifyToken: createTokenVerifier({ jwtSecret: SECRET }),
      allowedOrigins: ["https://the-book.pages.dev"],
      logger: { error: (e) => console.error("UNEXPECTED", e) }
    });

before(async () => {
  const { rows } = await pool.query("SELECT current_database() AS name");
  if (!rows[0].name.endsWith("_test")) throw new Error("Integration tests require a database ending in _test.");
});

after(() => pool.end());

/* ------------------------------------------------------------ helpers */

async function tokenFor(userId, email = `${userId}@example.invalid`) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setAudience("authenticated")
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));
}

async function call(who, method, path, body, { key = randomUUID(), profileId = who?.profileId, headers = {} } = {}) {
  const h = { ...headers };
  if (who) h.Authorization = `Bearer ${await tokenFor(who.userId)}`;
  if (profileId) h["X-Profile-Id"] = profileId;
  if (key && method !== "GET") h["Idempotency-Key"] = key;
  if (body !== undefined) h["Content-Type"] = "application/json";

  const response = await handle(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

function ok(res, status = 200) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
}

async function signUp(kind, extra = {}) {
  const user = { userId: randomUUID() };
  const res = await call(user, "POST", "/profiles", {
    kind,
    name: `API ${kind} ${user.userId.slice(0, 6)}`,
    county: "Cork",
    ...(kind === "artist" ? { actType: "Band", genres: ["Trad", "Folk"] } : {}),
    ...extra
  }, { profileId: null });
  const profile = ok(res, 201).profile;
  return { ...user, profileId: profile.id, profile };
}

/* An ISO instant for a wall-clock time in Europe/Dublin (handles IST). */
function dublin(date, time) {
  for (const offset of ["+00:00", "+01:00"]) {
    const iso = `${date}T${time}:00${offset}`;
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date(iso)).replace(", ", "T");
    if (local === `${date}T${time}`) return new Date(iso).toISOString();
  }
  throw new Error(`no such Dublin time ${date} ${time}`);
}

let dayCursor = 40;
/* A fresh future date per call, so tests never contend for the same night. */
function nextDate() {
  const d = new Date(Date.now() + dayCursor++ * 86400000);
  return d.toISOString().slice(0, 10);
}

function plusDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const expect = (b) => ({ expectedVersion: b.version, expectedTermsRevision: b.termsRevision });

async function confirmedRequest(venue, artist, night) {
  const created = ok(await call(venue, "POST", "/bookings", {
    artistProfileId: artist.profileId,
    eventDate: night,
    terms: { startsAt: dublin(night, "21:00"), endsAt: dublin(night, "23:30"), feeMinor: 60000, depositMinor: 10000 }
  }), 201).booking;
  const accepted = ok(await call(artist, "POST", `/bookings/${created.id}/accept`, expect(created))).booking;
  return ok(await call(venue, "POST", `/bookings/${created.id}/confirm`, expect(accepted))).booking;
}

/* -------------------------------------------------------------- tests */

test("health needs no sign-in; everything else does", async () => {
  ok(await call(null, "GET", "/health"));
  const res = await call(null, "GET", "/me");
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, "UNAUTHENTICATED");

  const forged = await handle(new Request("http://localhost/api/me", {
    headers: { Authorization: "Bearer not-a-real-token" }
  }));
  assert.equal(forged.status, 401);
});

test("creating a profile is idempotent per key and listed under /me", async () => {
  const user = { userId: randomUUID() };
  const key = randomUUID();
  const body = { kind: "venue", name: "The Crane Bar", county: "Galway" };
  const first = ok(await call(user, "POST", "/profiles", body, { key, profileId: null }), 201);
  const retry = ok(await call(user, "POST", "/profiles", body, { key, profileId: null }), 201);
  assert.equal(first.profile.id, retry.profile.id);

  const me = ok(await call(user, "GET", "/me", undefined, { profileId: null }));
  assert.equal(me.profiles.length, 1);
  assert.equal(me.profiles[0].role, "owner");
});

test("a venue request runs through accept and confirm, and both sides see it", async () => {
  const venue = await signUp("venue");
  const artist = await signUp("artist");
  const night = nextDate();

  const confirmed = await confirmedRequest(venue, artist, night);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.sessionDate, night);

  const venueView = ok(await call(venue, "GET", "/bookings")).bookings.find((b) => b.id === confirmed.id);
  assert.equal(venueView.bucket, "upcoming");
  assert.equal(venueView.terms.balanceMinor, 50000);
  assert.deepEqual(venueView.allowedActions, ["cancel", "message"]);

  const boot = ok(await call(artist, "GET", "/bootstrap"));
  assert.equal(boot.profile.id, artist.profileId);
  assert.ok(boot.bookings.some((b) => b.id === confirmed.id && b.side === "artist"));
  assert.ok(boot.availability.some((r) => r.date === night && r.kind === "booking"));
  assert.ok(boot.notifications.some((n) => n.type === "booking.confirmed"));
});

test("REGRESSION: a Saturday gig call can be confirmed for a 00:30 Sunday start", async () => {
  const venue = await signUp("venue");
  const artist = await signUp("artist");
  const night = nextDate();
  const morning = plusDays(night, 1);

  const callRes = ok(await call(venue, "POST", "/gig-calls", { eventDate: night, budgetMinor: 40000 }), 201);
  let b = ok(await call(artist, "POST", `/gig-calls/${callRes.gigCall.id}/applications`, { note: "Late set ok" }), 201).booking;
  b = ok(await call(venue, "POST", `/bookings/${b.id}/offer`, {
    ...expect(b),
    terms: { startsAt: dublin(morning, "00:30"), endsAt: dublin(morning, "02:30"), feeMinor: 40000, depositMinor: 0 }
  })).booking;
  assert.equal(b.eventDate, morning);
  assert.equal(b.sessionDate, night);

  b = ok(await call(artist, "POST", `/bookings/${b.id}/accept`, expect(b))).booking;
  const confirmed = ok(await call(venue, "POST", `/bookings/${b.id}/confirm`, expect(b))).booking;
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.sessionDate, night);
  assert.equal(confirmed.eventDate, morning);
});

test("an offer on a different night from the gig call is refused clearly", async () => {
  const venue = await signUp("venue");
  const artist = await signUp("artist");
  const night = nextDate();

  const callRes = ok(await call(venue, "POST", "/gig-calls", { eventDate: night }), 201);
  const b = ok(await call(artist, "POST", `/gig-calls/${callRes.gigCall.id}/applications`, {}), 201).booking;
  const res = await call(venue, "POST", `/bookings/${b.id}/offer`, {
    ...expect(b),
    terms: { startsAt: dublin(plusDays(night, 1), "21:00"), endsAt: dublin(plusDays(night, 1), "23:00"), feeMinor: 1000 }
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "OFFER_NOT_ON_GIG_NIGHT");
});

test("REGRESSION: cancelling a confirmed gig-call booking reopens the call for a new act", async () => {
  const venue = await signUp("venue");
  const artist = await signUp("artist");
  const standIn = await signUp("artist");
  const night = nextDate();

  const gig = ok(await call(venue, "POST", "/gig-calls", { eventDate: night }), 201).gigCall;
  let b = ok(await call(artist, "POST", `/gig-calls/${gig.id}/applications`, {}), 201).booking;
  b = ok(await call(venue, "POST", `/bookings/${b.id}/offer`, {
    ...expect(b), terms: { startsAt: dublin(night, "21:00"), endsAt: dublin(night, "23:00"), feeMinor: 30000, depositMinor: 0 }
  })).booking;
  b = ok(await call(artist, "POST", `/bookings/${b.id}/accept`, expect(b))).booking;
  b = ok(await call(venue, "POST", `/bookings/${b.id}/confirm`, expect(b))).booking;

  const cancelled = ok(await call(artist, "POST", `/bookings/${b.id}/transition`, {
    action: "cancel", reason: "Van broke down", ...expect(b)
  })).booking;
  assert.equal(cancelled.status, "cancelled_by_artist");

  const mine = ok(await call(venue, "GET", "/gig-calls")).gigCalls.find((g) => g.id === gig.id);
  assert.equal(mine.status, "open");
  assert.equal(mine.filledBookingId, null);

  ok(await call(standIn, "POST", `/gig-calls/${gig.id}/applications`, { note: "We can cover" }), 201);
});

test("cancelling an open gig call closes its applications", async () => {
  const venue = await signUp("venue");
  const a1 = await signUp("artist");
  const a2 = await signUp("artist");
  const gig = ok(await call(venue, "POST", "/gig-calls", { eventDate: nextDate() }), 201).gigCall;
  ok(await call(a1, "POST", `/gig-calls/${gig.id}/applications`, {}), 201);
  ok(await call(a2, "POST", `/gig-calls/${gig.id}/applications`, {}), 201);

  const res = ok(await call(venue, "POST", `/gig-calls/${gig.id}/cancel`, {}));
  assert.equal(res.gigCall.status, "cancelled");
  assert.equal(res.closedApplications, 2);

  const a1View = ok(await call(a1, "GET", "/bookings")).bookings[0];
  assert.equal(a1View.status, "not_selected");
  assert.equal(a1View.terminalReason, "gig_call_cancelled");
  assert.equal(a1View.bucket, "cancelled");
});

test("discovery hides artists who are booked or blocked that night", async () => {
  const venue = await signUp("venue");
  const booked = await signUp("artist", { county: "Leitrim", genres: ["Jazz"] });
  const blocked = await signUp("artist", { county: "Leitrim", genres: ["Jazz"] });
  const free = await signUp("artist", { county: "Leitrim", genres: ["Jazz"] });
  const night = nextDate();

  await confirmedRequest(venue, booked, night);
  ok(await call(blocked, "PUT", `/availability/${night}`));

  const found = ok(await call(venue, "GET", `/artists?county=Leitrim&genre=Jazz&date=${night}`)).artists.map((a) => a.id);
  assert.ok(found.includes(free.profileId));
  assert.ok(!found.includes(booked.profileId));
  assert.ok(!found.includes(blocked.profileId));

  // A blocked artist cannot be requested for that night at all.
  const res = await call(venue, "POST", "/bookings", {
    artistProfileId: blocked.profileId,
    terms: { startsAt: dublin(night, "21:00"), endsAt: dublin(night, "23:00"), feeMinor: 1000 }
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "ARTIST_UNAVAILABLE");

  ok(await call(blocked, "DELETE", `/availability/${night}`));
  const again = ok(await call(venue, "GET", `/artists?county=Leitrim&genre=Jazz&date=${night}`)).artists.map((a) => a.id);
  assert.ok(again.includes(blocked.profileId));
});

test("messages are private to the two sides of a booking", async () => {
  const venue = await signUp("venue");
  const artist = await signUp("artist");
  const outsider = await signUp("venue");
  const night = nextDate();

  const b = ok(await call(venue, "POST", "/bookings", {
    artistProfileId: artist.profileId,
    terms: { startsAt: dublin(night, "20:00"), endsAt: dublin(night, "22:00"), feeMinor: 20000 }
  }), 201).booking;

  ok(await call(venue, "POST", `/bookings/${b.id}/messages`, { text: "Can you do two sets?" }), 201);
  ok(await call(artist, "POST", `/bookings/${b.id}/messages`, { text: "Yes, 45 minutes each." }), 201);

  const thread = ok(await call(artist, "GET", `/bookings/${b.id}/messages`));
  assert.deepEqual(thread.messages.map((m) => [m.text, m.mine]), [
    ["Can you do two sets?", false],
    ["Yes, 45 minutes each.", true]
  ]);

  assert.equal((await call(outsider, "GET", `/bookings/${b.id}/messages`)).status, 404);
  assert.equal((await call(outsider, "POST", `/bookings/${b.id}/messages`, { text: "hi" })).status, 404);
});

test("reviews open only after a confirmed gig has finished, once per side", async () => {
  const venue = await signUp("venue");
  const artist = await signUp("artist");

  const upcoming = await confirmedRequest(venue, artist, nextDate());
  const early = await call(venue, "POST", `/bookings/${upcoming.id}/reviews`, { score: 5 });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, "REVIEW_NOT_OPEN");

  // A finished gig cannot be created through the API (it would start in
  // the past), so it is written directly as a fixture.
  const past = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO book.bookings (id, artist_profile_id, venue_profile_id, origin, event_date,
         status, terms_revision, accepted_terms_revision, created_by_user_id)
       VALUES ($1, $2, $3, 'venue_request', current_date - 3, 'accepted', 1, 1, $4)`,
      [past, artist.profileId, venue.profileId, venue.userId]
    );
    await client.query(
      `INSERT INTO book.booking_terms (booking_id, revision, starts_at, ends_at, agreed_fee_minor, agreed_deposit_minor, created_by_user_id)
       VALUES ($1, 1, ((current_date - 3) + time '20:00') AT TIME ZONE 'Europe/Dublin',
                      ((current_date - 3) + time '22:00') AT TIME ZONE 'Europe/Dublin', 30000, 0, $2)`,
      [past, venue.userId]
    );
    await client.query(
      `UPDATE book.bookings SET status = 'confirmed', confirmed_at = now() - interval '5 days' WHERE id = $1`,
      [past]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  ok(await call(venue, "POST", `/bookings/${past}/reviews`, { score: 5, note: "Packed the room" }), 201);
  ok(await call(artist, "POST", `/bookings/${past}/reviews`, { score: 4 }), 201);
  const twice = await call(venue, "POST", `/bookings/${past}/reviews`, { score: 1 });
  assert.equal(twice.body.error.code, "REVIEW_ALREADY_SUBMITTED");

  const artists = ok(await call(venue, "GET", "/artists?county=Cork")).artists;
  const rated = artists.find((a) => a.id === artist.profileId);
  assert.equal(rated.rating, 5);
  assert.equal(rated.reviewCount, 1);
});

test("notifications reach the other side, not the actor, and can be marked read", async () => {
  const venue = await signUp("venue");
  const artist = await signUp("artist");
  const night = nextDate();

  ok(await call(venue, "POST", "/bookings", {
    artistProfileId: artist.profileId,
    terms: { startsAt: dublin(night, "20:00"), endsAt: dublin(night, "22:00"), feeMinor: 20000 }
  }), 201);

  assert.equal(ok(await call(venue, "GET", "/notifications")).notifications.length, 0);
  const inbox = ok(await call(artist, "GET", "/notifications"));
  assert.equal(inbox.unreadCount, 1);
  assert.equal(inbox.notifications[0].type, "booking.requested");

  ok(await call(artist, "POST", `/notifications/${inbox.notifications[0].id}/read`, {}));
  assert.equal(ok(await call(artist, "GET", "/notifications")).unreadCount, 0);
});

test("bad input, stale views, and other people's profiles are refused", async () => {
  const venue = await signUp("venue");
  const artist = await signUp("artist");
  const night = nextDate();
  const terms = { startsAt: dublin(night, "20:00"), endsAt: dublin(night, "22:00"), feeMinor: 20000 };

  const noOffset = await call(venue, "POST", "/bookings", {
    artistProfileId: artist.profileId, terms: { ...terms, startsAt: `${night}T20:00` }
  });
  assert.equal(noOffset.status, 400);
  assert.match(noOffset.body.error.message, /terms.startsAt/);

  const wrongNight = await call(venue, "POST", "/bookings", {
    artistProfileId: artist.profileId, eventDate: plusDays(night, 3), terms
  });
  assert.equal(wrongNight.status, 400);

  const noKey = await call(venue, "POST", "/bookings", { artistProfileId: artist.profileId, terms }, { key: null });
  assert.equal(noKey.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");

  const notMine = await call(venue, "GET", "/bookings", undefined, { profileId: artist.profileId });
  assert.equal(notMine.status, 404);

  const b = ok(await call(venue, "POST", "/bookings", { artistProfileId: artist.profileId, terms }), 201).booking;
  ok(await call(venue, "POST", `/bookings/${b.id}/offer`, {
    ...expect(b), terms: { ...terms, feeMinor: 25000 }
  }));
  const stale = await call(artist, "POST", `/bookings/${b.id}/accept`, expect(b));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "STALE_BOOKING");

  const artistCannotConfirm = await call(artist, "POST", `/bookings/${b.id}/confirm`, { expectedVersion: 2, expectedTermsRevision: 2 });
  assert.equal(artistCannotConfirm.status, 403);
});

test("retrying a request with the same key replays instead of duplicating", async () => {
  const venue = await signUp("venue");
  const artist = await signUp("artist");
  const night = nextDate();
  const key = randomUUID();
  const body = {
    artistProfileId: artist.profileId,
    terms: { startsAt: dublin(night, "20:00"), endsAt: dublin(night, "22:00"), feeMinor: 20000 }
  };

  const first = ok(await call(venue, "POST", "/bookings", body, { key }), 201);
  const again = ok(await call(venue, "POST", "/bookings", body, { key }), 201);
  assert.equal(first.booking.id, again.booking.id);
  assert.equal(ok(await call(venue, "GET", "/bookings")).bookings.length, 1);

  const reused = await call(venue, "POST", "/bookings", { ...body, terms: { ...body.terms, feeMinor: 1 } }, { key });
  assert.equal(reused.body.error.code, "IDEMPOTENCY_KEY_REUSED");
});

test("CORS headers go only to allowed origins", async () => {
  const allowed = await handle(new Request("http://localhost/api/health", { headers: { Origin: "https://the-book.pages.dev" } }));
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://the-book.pages.dev");

  const other = await handle(new Request("http://localhost/api/health", { headers: { Origin: "https://evil.example" } }));
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});
