# Session-date overlap reproduction

Evidence for Phase 5 of the Windows runbook. These scripts demonstrate what
`002_session_date.sql` fixes, what it leaves open, and why the complete
migration needs all four Phase 5 items rather than item 1 alone.

Verified on PostgreSQL 16.15. The runbook reports the same behaviour on 16.13.

**These scripts drop indexes and constraints.** Each refuses to run on any
database not named `thebook_scratch`. Never point them at `thebook_dev` or
`thebook_test`.

## Running

Scripts `01` and `02` must share a psql session — `02` reuses the `pg_temp`
helpers `01` defines. `03` needs a database where 001's
`bookings_confirmed_artist_date` still exists, so it needs a rebuild first.

```sh
cd server

# 01 + 02, one session
dropdb -U postgres --if-exists thebook_scratch
createdb -U postgres thebook_scratch
psql -U postgres -d thebook_scratch -q -v ON_ERROR_STOP=1 -f migrations/001_booking_foundation.sql
psql -U postgres -d thebook_scratch -q -v ON_ERROR_STOP=1 -f migrations/002_session_date.sql
psql -U postgres -d thebook_scratch \
  -f tests/overlap/01_session_date_repro.sql \
  -f tests/overlap/02_overlap_hole.sql

# 03 on a fresh database
dropdb -U postgres thebook_scratch
createdb -U postgres thebook_scratch
psql -U postgres -d thebook_scratch -q -v ON_ERROR_STOP=1 -f migrations/001_booking_foundation.sql
psql -U postgres -d thebook_scratch -q -v ON_ERROR_STOP=1 -f migrations/002_session_date.sql
psql -U postgres -d thebook_scratch -f tests/overlap/03_false_rejection.sql
```

## What each case shows

| Case | Setup | Result |
|---|---|---|
| A | 001 + 002 | Sat 23:00→03:00 and Sun 00:30→02:00 collapse to one `session_date`; second confirmation blocked. **002 works.** |
| B | 001 + 002 | 05:00→07:00 and 06:30→08:00 have *different* session dates. The session index permits both; 001's `bookings_confirmed_artist_date` is what blocks them. |
| C | items 1 + 2, no item 3 | Same pair, both confirm, overlapping 06:30–07:00, holding reservations on two sessions. **The hole.** |
| D | items 1 + 2 | A 05:00→07:00 booking occupies time in two sessions — what item 3 forbids. |
| F | 001 + 002 | 01:00→04:00 and 21:00→23:00, different sessions, no overlap, **falsely rejected** by `bookings_confirmed_artist_date`. |

## The point for whoever writes the migration

Case B and case F are the same index seen from two sides.
`bookings_confirmed_artist_date` must be retired as part of moving
availability to `session_date`, because while it survives it falsely rejects
legitimate bookings (F). But retiring it is exactly what opens the overlap
hole (C).

So item 3 — a performance may not cross the next 06:00 boundary — is not a
refinement to add later. Items 1, 2 and 4 without item 3 are strictly worse
than the current schema. All four land together, in one migration, or none
of them do.

Item 3 also makes the simple unique index sufficient: if every booking ends
by the next 06:00, session S occupies at most `[S 06:00, S+1 06:00]`, so two
bookings on different sessions cannot overlap by construction. No exclusion
constraint is needed.

## Not covered here

The runbook asks the dev for boundary tests that these scripts do **not**
include, and they should ship with the migration:

- 05:59, and exactly 06:00
- both Dublin DST changeovers, where `AT TIME ZONE 'Europe/Dublin'` combined
  with `- interval '6 hours'` is most likely to surprise
- a booking crossing the 06:00 seam

Also unresolved: the composite FK ties a booking to the gig call's
`event_date`, but a Saturday-night gig call can legitimately produce a Sunday
00:30 start. That needs resolving, not renaming.
