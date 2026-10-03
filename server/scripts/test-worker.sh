#!/bin/sh
# Runs tests/api.test.js against the API inside the local Workers runtime
# (wrangler dev), to check the Cloudflare build behaves like the Node one.
#
#   TEST_DATABASE_URL=... sh scripts/test-worker.sh
#
# Needs server/.dev.vars with DATABASE_URL (the same _test database),
# SUPABASE_JWT_SECRET=test-secret-at-least-32-characters-long!! and
# ALLOWED_ORIGINS=https://the-book.pages.dev, matching tests/api.test.js.
set -u
cd "$(dirname "$0")/.."
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
PORT=${PORT:-8788}

npx wrangler dev --port "$PORT" --ip 127.0.0.1 > .wrangler-dev.log 2>&1 &
DEV_PID=$!
# npx starts wrangler, which starts workerd; stop the whole tree.
trap 'pkill -f "wrangler dev --port $PORT" 2>/dev/null; pkill -f "work[e]rd serve" 2>/dev/null; kill $DEV_PID 2>/dev/null' EXIT

for i in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && break
  sleep 1
done

API_TEST_URL="http://127.0.0.1:$PORT" node --test tests/api.test.js
