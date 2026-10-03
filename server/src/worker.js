/*
 * Cloudflare Worker entry point: the same fetch-style API as src/app.js,
 * running on Workers with the nodejs_compat flag (see wrangler.toml).
 *
 * Secrets (wrangler secret put, or the deploy workflow):
 *   DATABASE_URL          Postgres connection string. On Supabase, use the
 *                         transaction pooler (port 6543).
 *   SUPABASE_URL          or SUPABASE_JWT_SECRET, to verify sign-ins
 * Vars (wrangler.toml):
 *   ALLOWED_ORIGINS       comma-separated browser origins, e.g. the Pages URL
 *
 * A Worker may not reuse a database connection across requests, so each
 * request gets its own small pool, closed once the response is sent.
 */

import { createApp } from "./http/app.js";
import { createTokenVerifier } from "./http/auth.js";
import { createPool } from "./db/pool.js";

let verifier;
let verifierKey;

function verifierFor(env) {
  const key = `${env.SUPABASE_URL || ""}|${env.SUPABASE_JWT_SECRET ? "secret" : ""}`;
  if (!verifier || verifierKey !== key) {
    verifier = createTokenVerifier({ supabaseUrl: env.SUPABASE_URL, jwtSecret: env.SUPABASE_JWT_SECRET });
    verifierKey = key;
  }
  return verifier;
}

export default {
  async fetch(request, env, ctx) {
    const pool = createPool(env.DATABASE_URL, { max: 3, connectionTimeoutMillis: 10_000 });

    const handle = createApp({
      pool,
      verifyToken: verifierFor(env),
      allowedOrigins: (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)
    });

    try {
      return await handle(request);
    } finally {
      ctx.waitUntil(pool.end().catch(() => {}));
    }
  }
};
