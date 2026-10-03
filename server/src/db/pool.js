import pg from "pg";

// DATE columns come back as "YYYY-MM-DD" strings, not JS Dates at local
// midnight: a booking night must not shift with the server's timezone.
pg.types.setTypeParser(1082, (value) => value);

export function createPool(connectionString, options = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  return new pg.Pool({ connectionString, max: 10, ...options });
}
