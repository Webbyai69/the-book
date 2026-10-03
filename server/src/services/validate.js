/*
 * Input checks for values that arrive from the client. The database has the
 * final word on every rule, but a 400 that names the field is more useful
 * than a constraint violation, and some inputs (timestamps without an
 * offset) are accepted by Postgres with a meaning the client did not intend.
 */

import { HttpError } from "../db/errors.js";

export const COUNTIES = [
  "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin",
  "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim",
  "Limerick", "Longford", "Louth", "Mayo", "Meath", "Monaghan",
  "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford",
  "Westmeath", "Wexford", "Wicklow"
];

export const ACT_TYPES = ["Band", "Solo", "Duo or trio", "DJ"];

export const GENRES = ["Rock", "Pop", "Country", "Jazz", "Indie", "Electronic", "Folk", "Trad"];

const MAX_MINOR = 10_000_000; // EUR 100,000

export function invalid(field, message) {
  return new HttpError(400, "INVALID_INPUT", `${field}: ${message}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(field, "must be an id.");
  return value.toLowerCase();
}

export function date(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid(field, "must be a date as YYYY-MM-DD.");
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw invalid(field, "is not a real date.");
  }
  return value;
}

// An instant must carry its offset: "2026-11-07T23:00" alone is ambiguous.
export function instant(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(field, "is required.");
    return null;
  }
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw invalid(field, "must be an ISO 8601 timestamp with a timezone offset.");
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw invalid(field, "is not a valid timestamp.");
  return d.toISOString();
}

export function minor(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(field, "is required.");
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_MINOR) {
    throw invalid(field, "must be a whole number of cents between 0 and 10000000.");
  }
  return value;
}

export function text(value, field, { max, min = 0, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalid(field, "is required.");
    return "";
  }
  if (typeof value !== "string") throw invalid(field, "must be text.");
  const trimmed = value.trim();
  if (trimmed.length < min) throw invalid(field, min > 1 ? `must be at least ${min} characters.` : "is required.");
  if (trimmed.length > max) throw invalid(field, `must be at most ${max} characters.`);
  return trimmed;
}

export function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw invalid(field, `must be one of: ${allowed.join(", ")}.`);
  return value;
}

/*
 * Terms as proposed by a venue. `complete` is what an artist can accept:
 * times and a fee. The deposit is only required at confirmation.
 */
export function terms(input, { complete }) {
  if (input === null || typeof input !== "object") throw invalid("terms", "are required.");

  const t = {
    startsAt: instant(input.startsAt, "terms.startsAt", { required: complete }),
    endsAt: instant(input.endsAt, "terms.endsAt", { required: complete }),
    arrivalAt: instant(input.arrivalAt, "terms.arrivalAt"),
    soundcheckAt: instant(input.soundcheckAt, "terms.soundcheckAt"),
    feeMinor: minor(input.feeMinor, "terms.feeMinor", { required: complete }),
    depositMinor: minor(input.depositMinor, "terms.depositMinor"),
    details: text(input.details, "terms.details", { max: 2000 })
  };

  if ((t.startsAt === null) !== (t.endsAt === null)) {
    throw invalid("terms", "send both startsAt and endsAt, or neither.");
  }
  if (t.startsAt && t.endsAt <= t.startsAt) {
    throw invalid("terms.endsAt", "must be after startsAt.");
  }
  if (t.feeMinor !== null && t.depositMinor !== null && t.depositMinor > t.feeMinor) {
    throw invalid("terms.depositMinor", "cannot be more than the fee.");
  }

  return t;
}

/* The calendar date of an instant in Europe/Dublin, as YYYY-MM-DD. */
export function dublinDate(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(iso));
}

/* The gig night an instant belongs to: anything before 06:00 local is the
   previous night. Mirrors book.set_session_date(). */
export function sessionDate(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type).value;
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  if (Number(get("hour")) >= 6) return day;
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
