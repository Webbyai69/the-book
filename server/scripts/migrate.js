/*
 * Applies server/migrations/*.sql in filename order, once each.
 *
 *   DATABASE_URL=postgres://... node scripts/migrate.js
 *
 * Applied files are recorded in book_migrations.applied with a checksum. A
 * file that changes after it was applied aborts the run: migrations are
 * append-only from here on, so fix forward with a new numbered file.
 *
 * Databases migrated by hand before this runner existed are baselined: if
 * the book schema already exists but nothing is recorded, every file whose
 * effect is detectably present is recorded without being re-run.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// How to tell, on an untracked database, whether a file was already applied.
const BASELINE_PROBES = {
  "001_booking_foundation.sql": `SELECT to_regclass('book.bookings') IS NOT NULL`,
  "002_session_date.sql": `SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'book' AND table_name = 'bookings' AND column_name = 'session_date')`,
  "003_derived_event_date_messages_reviews.sql": `SELECT to_regclass('book.booking_messages') IS NOT NULL`
};

export async function migrate(connectionString, { log = console.log } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // One runner at a time.
    await client.query("SELECT pg_advisory_lock(hashtext('the-book-migrations'))");

    // Its own schema, not public: Supabase's Data API exposes public.
    await client.query(`CREATE SCHEMA IF NOT EXISTS book_migrations`);
    await client.query(`REVOKE ALL ON SCHEMA book_migrations FROM PUBLIC`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS book_migrations.applied (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    const applied = new Map(
      (await client.query("SELECT filename, checksum FROM book_migrations.applied")).rows.map(
        (r) => [r.filename, r.checksum]
      )
    );

    const sources = new Map();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      sources.set(file, { sql, checksum: createHash("sha256").update(sql).digest("hex") });
    }

    if (applied.size === 0) {
      for (const file of files) {
        const probe = BASELINE_PROBES[file];
        if (!probe) break;
        const present = (await client.query(probe)).rows[0];
        if (!Object.values(present)[0]) break;
        await client.query(
          "INSERT INTO book_migrations.applied (filename, checksum) VALUES ($1, $2)",
          [file, sources.get(file).checksum]
        );
        applied.set(file, sources.get(file).checksum);
        log(`baselined ${file} (already present)`);
      }
    }

    let ran = 0;
    for (const file of files) {
      const { sql, checksum } = sources.get(file);

      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(
            `${file} changed after it was applied. Add a new migration instead of editing this one.`
          );
        }
        continue;
      }

      // Each file manages its own BEGIN/COMMIT, so the record is written
      // straight after; a failure inside the file leaves it unrecorded.
      log(`applying ${file}`);
      await client.query(sql);
      await client.query(
        "INSERT INTO book_migrations.applied (filename, checksum) VALUES ($1, $2)",
        [file, checksum]
      );
      ran += 1;
    }

    log(ran ? `applied ${ran} migration(s)` : "database is up to date");
    return ran;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }
  migrate(url).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
