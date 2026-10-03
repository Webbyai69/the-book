/*
 * Node entry point: serves the fetch-style API (src/http/app.js) over
 * node:http.
 *
 *   npm start           reads server/.env (see .env.example)
 */

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createApp } from "./http/app.js";
import { createTokenVerifier } from "./http/auth.js";
import { createPool } from "./db/pool.js";

export function toNodeHandler(handle) {
  return async (req, res) => {
    try {
      const url = `http://${req.headers.host || "localhost"}${req.url}`;
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, val]) =>
          Array.isArray(val) ? val.map((x) => [k, x]) : [[k, val]]
        ),
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? "half" : undefined
      });

      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "INTERNAL", message: "Something went wrong on our side." } }));
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool(process.env.DATABASE_URL);
  const handle = createApp({
    pool,
    verifyToken: createTokenVerifier({
      supabaseUrl: process.env.SUPABASE_URL,
      jwtSecret: process.env.SUPABASE_JWT_SECRET
    }),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)
  });

  const port = Number(process.env.PORT || 8787);
  const server = createServer(toNodeHandler(handle)).listen(port, () => {
    console.log(`The Book API listening on http://localhost:${port}/api`);
  });

  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
