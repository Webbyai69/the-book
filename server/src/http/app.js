/*
 * The Book API as a single fetch-style handler: (Request) => Response.
 *
 * Written against the web-standard Request/Response so the same code runs
 * under Node (src/app.js) and, later, a Cloudflare Worker. The routes are
 * the ones the browser client in api.js already calls.
 *
 * Every route except /health requires a verified Supabase token. Routes
 * that act as a profile take it from the X-Profile-Id header (or a
 * profileId query parameter); membership of that profile is checked inside
 * each service, in the same transaction as the work.
 */

import { HttpError } from "../db/errors.js";
import * as lifecycle from "../services/booking-lifecycle.js";
import { confirmBooking } from "../services/confirm-booking.js";
import * as conversation from "../services/conversation.js";
import * as gigCalls from "../services/gig-calls.js";
import * as profiles from "../services/profiles.js";
import * as queries from "../services/queries.js";
import * as v from "../services/validate.js";
import { createUserSync } from "./auth.js";

const MAX_BODY_BYTES = 64 * 1024;

/* [method, pattern, handler, options]. Patterns are matched in order. */
function routes() {
  const expected = (body) => ({
    expectedVersion: version(body.expectedVersion, "expectedVersion"),
    expectedTermsRevision: version(body.expectedTermsRevision, "expectedTermsRevision")
  });

  return [
    ["GET", "/me", (c) => queries.listMyProfiles(c.pool, c.auth)],
    ["POST", "/profiles", (c) =>
      profiles.createProfile(c.pool, { ...c.body, ...c.auth, idempotencyKey: c.key }), { status: 201 }],
    ["PATCH", "/profiles/:id", (c) =>
      profiles.updateProfile(c.pool, { ...c.body, ...c.auth, profileId: v.uuid(c.params.id, "profileId"), idempotencyKey: c.key })],

    ["GET", "/bootstrap", (c) => queries.bootstrap(c.pool, c.actor())],
    ["GET", "/artists", (c) => queries.discoverArtists(c.pool, c.query)],

    ["GET", "/gig-calls", (c) => queries.listGigCalls(c.pool, { profileId: c.optionalProfileId(), county: c.query.county })],
    ["POST", "/gig-calls", (c) =>
      gigCalls.createGigCall(c.pool, { ...c.body, ...c.actor(), idempotencyKey: c.key }), { status: 201 }],
    ["POST", "/gig-calls/:id/cancel", (c) =>
      gigCalls.cancelGigCall(c.pool, { ...c.actor(), gigCallId: c.params.id, idempotencyKey: c.key })],
    ["POST", "/gig-calls/:id/applications", (c) =>
      lifecycle.createApplication(c.pool, { ...c.actor(), gigCallId: c.params.id, note: c.body.note, idempotencyKey: c.key }),
      { status: 201 }],

    ["GET", "/bookings", (c) => queries.listBookings(c.pool, c.actor())],
    ["POST", "/bookings", (c) =>
      lifecycle.createBookingRequest(c.pool, {
        ...c.actor(),
        artistProfileId: c.body.artistProfileId,
        eventDate: c.body.eventDate,
        terms: c.body.terms,
        idempotencyKey: c.key
      }), { status: 201 }],
    ["GET", "/bookings/:id", (c) => queries.getBooking(c.pool, { ...c.actor(), bookingId: c.params.id })],
    ["POST", "/bookings/:id/offer", (c) =>
      lifecycle.makeOffer(c.pool, {
        ...c.actor(), bookingId: c.bookingId(), ...expected(c.body), terms: c.body.terms, idempotencyKey: c.key
      })],
    ["POST", "/bookings/:id/accept", (c) =>
      lifecycle.acceptBooking(c.pool, { ...c.actor(), bookingId: c.bookingId(), ...expected(c.body), idempotencyKey: c.key })],
    ["POST", "/bookings/:id/transition", (c) =>
      lifecycle.transitionBooking(c.pool, {
        ...c.actor(), bookingId: c.bookingId(), action: c.body.action, reason: c.body.reason,
        ...expected(c.body), idempotencyKey: c.key
      })],
    ["POST", "/bookings/:id/confirm", (c) =>
      confirmBooking(c.pool, { ...c.actor(), bookingId: c.bookingId(), ...expected(c.body), idempotencyKey: c.key })],
    ["GET", "/bookings/:id/messages", (c) =>
      conversation.listMessages(c.pool, { ...c.actor(), bookingId: c.params.id })],
    ["POST", "/bookings/:id/messages", (c) =>
      conversation.sendMessage(c.pool, { ...c.actor(), bookingId: c.params.id, text: c.body.text, idempotencyKey: c.key }),
      { status: 201 }],
    ["POST", "/bookings/:id/reviews", (c) =>
      conversation.submitReview(c.pool, {
        ...c.actor(), bookingId: c.params.id, score: c.body.score, note: c.body.note, idempotencyKey: c.key
      }), { status: 201 }],

    ["GET", "/notifications", (c) => queries.listNotifications(c.pool, c.actor())],
    ["POST", "/notifications/:id/read", (c) =>
      profiles.markNotificationRead(c.pool, { ...c.actor(), notificationId: c.params.id })],

    ["PUT", "/availability/:date", (c) => profiles.blockNight(c.pool, { ...c.actor(), date: c.params.date })],
    ["DELETE", "/availability/:date", (c) => profiles.unblockNight(c.pool, { ...c.actor(), date: c.params.date })]
  ].map(([method, pattern, handler, options = {}]) => ({
    method,
    handler,
    options,
    keys: [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]),
    regex: new RegExp(`^${pattern.replace(/:(\w+)/g, "([^/]+)")}$`)
  }));
}

function version(value, field) {
  if (!Number.isInteger(value) || value < 1) throw v.invalid(field, "must be the version you last saw.");
  return value;
}

function json(status, payload, headers = {}) {
  return new Response(payload === null ? null : JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}

function errorResponse(error) {
  return json(error.statusCode, { error: { code: error.code, message: error.message } });
}

async function readBody(request) {
  if (request.method === "GET" || request.method === "DELETE" || request.method === "OPTIONS") return {};

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "BODY_TOO_LARGE", "The request is too large.");

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "BODY_TOO_LARGE", "The request is too large.");
  if (!raw) return {};

  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "JSON_REQUIRED", "Send the request body as application/json.");
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_JSON", "The request body must be a JSON object.");
  }
  return body;
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return match[1];
}

/*
 * options:
 *   pool            pg Pool
 *   verifyToken     (token) => { userId, email }   see auth.js
 *   allowedOrigins  origins allowed to call cross-origin (CORS); empty means
 *                   same-origin only
 *   basePath        prefix stripped before routing, default "/api"
 *   logger          receives unexpected errors
 */
export function createApp({ pool, verifyToken, allowedOrigins = [], basePath = "/api", logger = console }) {
  const table = routes();
  const syncUser = createUserSync(pool);
  const origins = new Set(allowedOrigins);

  function corsHeaders(request) {
    const origin = request.headers.get("origin");
    if (!origin || !origins.has(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Profile-Id",
      "Access-Control-Max-Age": "600",
      Vary: "Origin"
    };
  }

  async function route(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) path = path.slice(basePath.length);
    path = path.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return json(204, null);

    if (path === "/health" && request.method === "GET") {
      await pool.query("SELECT 1");
      return json(200, { ok: true });
    }

    const candidates = table.filter((r) => r.regex.test(path));
    if (!candidates.length) throw new HttpError(404, "NOT_FOUND", "No such endpoint.");
    const match = candidates.find((r) => r.method === request.method);
    if (!match) throw new HttpError(405, "METHOD_NOT_ALLOWED", "That method is not supported here.");

    const auth = await verifyToken(bearer(request));
    await syncUser(auth);

    const values = match.regex.exec(path).slice(1).map(decodeURIComponent);
    const params = Object.fromEntries(match.keys.map((k, i) => [k, values[i]]));
    const query = Object.fromEntries(url.searchParams);
    const body = await readBody(request);
    const rawProfile = request.headers.get("x-profile-id") || query.profileId || null;

    const context = {
      pool,
      auth,
      params,
      query,
      body,
      key: request.headers.get("idempotency-key"),
      optionalProfileId: () => (rawProfile ? v.uuid(rawProfile, "X-Profile-Id") : null),
      actor: () => {
        if (!rawProfile) {
          throw new HttpError(400, "PROFILE_REQUIRED", "Choose which of your profiles to act as (X-Profile-Id).");
        }
        return { userId: auth.userId, profileId: v.uuid(rawProfile, "X-Profile-Id") };
      },
      bookingId: () => v.uuid(params.id, "bookingId")
    };

    const result = await match.handler(context);
    return json(match.options.status || 200, result);
  }

  return async function handle(request) {
    const cors = corsHeaders(request);
    let response;

    try {
      response = await route(request);
    } catch (error) {
      if (error instanceof HttpError) {
        response = errorResponse(error);
      } else {
        logger.error(error);
        response = errorResponse(
          new HttpError(500, "INTERNAL", "Something went wrong on our side. Try again in a moment.")
        );
      }
    }

    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  };
}
