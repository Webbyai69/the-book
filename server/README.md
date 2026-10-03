# The Book API

Node 22 + PostgreSQL 16. Sign-in is Supabase Auth; the API verifies the
Supabase access token on every request and never trusts the client about who
the user is or which profile they may act as.

## Run it locally

```
cd server
cp .env.example .env        # then fill in DATABASE_URL and a Supabase key
npm ci
npm run migrate             # applies migrations/*.sql once each
npm start                   # http://localhost:8787/api
```

## Tests

Both suites need a database whose name ends in `_test`, with migrations applied.

```
DATABASE_URL=$TEST_DATABASE_URL npm run migrate
npm test                    # Node: services + the HTTP API end to end
npm run test:sql            # SQL harnesses for the schema rules
```

GitHub Actions runs both on every push that touches `server/`
(`.github/workflows/server-tests.yml`).

## Migrations

`npm run migrate` records each applied file in `public.schema_migrations` with
a checksum, and refuses to run if an applied file has since been edited.
Migrations are append-only: fix forward with a new numbered file. A database
migrated by hand before the runner existed is detected and baselined.

## Endpoints

All paths are under `/api`. Every route except `/health` needs
`Authorization: Bearer <Supabase access token>`. Routes that act as a profile
need `X-Profile-Id`. Every change needs an `Idempotency-Key`; reuse the same key
when retrying, so a retry replays instead of duplicating.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | Database reachable |
| GET | `/me` | The signed-in user's profiles |
| POST | `/profiles` | Create an artist or venue profile |
| PATCH | `/profiles/:id` | Edit name, county, bio, published, act type, genres, fee |
| GET | `/bootstrap` | Everything the app shell needs for one profile |
| GET | `/artists?county&actType&genre&date` | Published artists; with `date`, only those free that night |
| GET | `/gig-calls?county` | Open calls, plus the venue's own |
| POST | `/gig-calls` | Venue posts a call |
| POST | `/gig-calls/:id/cancel` | Venue cancels an open call; closes its applications |
| POST | `/gig-calls/:id/applications` | Artist applies |
| GET | `/bookings` | Bookings for the profile, with `bucket` (pending / upcoming / completed / cancelled) and `allowedActions` |
| GET | `/bookings/:id` | One booking |
| POST | `/bookings` | Venue requests an artist with terms |
| POST | `/bookings/:id/offer` | Venue offers or revises terms (clears acceptance) |
| POST | `/bookings/:id/accept` | Artist accepts the current terms |
| POST | `/bookings/:id/transition` | `decline`, `withdraw`, `reject` or `cancel` |
| POST | `/bookings/:id/confirm` | Venue confirms; reserves the artist's night |
| GET / POST | `/bookings/:id/messages` | The booking's thread |
| POST | `/bookings/:id/reviews` | 1–5 score after a confirmed gig has finished |
| GET | `/notifications` | Latest 50 and the unread count |
| POST | `/notifications/:id/read` | Mark one read (`all` marks every one) |
| PUT / DELETE | `/availability/:date` | Artist blocks or unblocks a night |

Errors are `{ "error": { "code", "message" } }`. 409 means the request
conflicts with the booking's current state; refresh and try again.

## Times and nights

Times are ISO 8601 instants with an offset. A booking's night
(`sessionDate`) is the Europe/Dublin date of its start, with anything before
06:00 counting as the night before. A set may not run past 06:00 the next
morning. One artist, one confirmed booking per night.

## Code layout

```
src/app.js                 Node entry point
src/http/app.js            routes -> services, as a fetch-style (Request) => Response handler
src/http/auth.js           Supabase token verification, users table sync
src/services/              booking lifecycle, confirmation, gig calls, profiles,
                           messages and reviews, read queries, input validation
src/db/                    pool, shared command envelope, events, error mapping
migrations/                schema, applied in order by scripts/migrate.js
```

The handler uses only web-standard `Request`/`Response`, so the same code can
run in a Cloudflare Worker.
