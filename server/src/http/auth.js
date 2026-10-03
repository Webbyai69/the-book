/*
 * Sign-in is Supabase Auth: the browser holds a Supabase access token (a
 * JWT) and sends it as "Authorization: Bearer ...". The API verifies it
 * here and never trusts anything else to say who the user is.
 *
 * Two verification modes, matching Supabase's two kinds of signing key:
 *   SUPABASE_URL         asymmetric keys, fetched from the project's JWKS
 *   SUPABASE_JWT_SECRET  the legacy shared HS256 secret
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "../db/errors.js";

export function createTokenVerifier({ supabaseUrl, jwtSecret, audience = "authenticated" } = {}) {
  let key;
  let issuer;

  if (supabaseUrl) {
    const base = supabaseUrl.replace(/\/+$/, "");
    key = createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
    issuer = `${base}/auth/v1`;
  } else if (jwtSecret) {
    key = new TextEncoder().encode(jwtSecret);
  } else {
    throw new Error("Set SUPABASE_URL or SUPABASE_JWT_SECRET so the API can verify sign-ins.");
  }

  return async function verify(token) {
    try {
      const { payload } = await jwtVerify(token, key, {
        audience,
        ...(issuer ? { issuer } : {}),
        algorithms: supabaseUrl ? ["RS256", "ES256"] : ["HS256"]
      });

      if (typeof payload.sub !== "string" || !payload.sub) throw new Error("token has no subject");

      return { userId: payload.sub, email: typeof payload.email === "string" ? payload.email : "" };
    } catch {
      throw new HttpError(401, "UNAUTHENTICATED", "Your session has expired. Sign in again.");
    }
  };
}

/*
 * book.users mirrors Supabase Auth users. The first authenticated request
 * creates the row; later ones only touch it if the email changed. Seen ids
 * are remembered per process to skip the write entirely.
 */
export function createUserSync(pool) {
  const seen = new Map();

  return async function syncUser({ userId, email }) {
    if (seen.get(userId) === email) return;

    try {
      await pool.query(
        `INSERT INTO book.users (id, email) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email
         WHERE book.users.email IS DISTINCT FROM EXCLUDED.email`,
        [userId, email]
      );
    } catch (error) {
      // A non-uuid subject cannot be a Supabase user.
      if (error.code === "22P02") {
        throw new HttpError(401, "UNAUTHENTICATED", "Your session is not valid. Sign in again.");
      }
      throw error;
    }

    if (seen.size > 10_000) seen.clear();
    seen.set(userId, email);
  };
}
