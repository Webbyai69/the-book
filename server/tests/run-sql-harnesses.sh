#!/bin/sh
# Runs the SQL harnesses against TEST_DATABASE_URL and fails if any check
# prints FAIL or none print PASS. The harnesses report through NOTICEs
# rather than exit codes, so the output is what has to be read.
set -eu
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
dir=$(dirname "$0")
status=0
for f in "$dir"/sql_harness.sql "$dir"/lifecycle_harness.sql "$dir"/session_date_harness.sql; do
  out=$(psql "$TEST_DATABASE_URL" -f "$f" 2>&1)
  pass=$(printf '%s\n' "$out" | grep -c 'PASS' || true)
  fail=$(printf '%s\n' "$out" | grep 'FAIL' || true)
  echo "$(basename "$f"): $pass passed"
  if [ -n "$fail" ] || [ "$pass" -eq 0 ]; then
    printf '%s\n' "$fail"
    status=1
  fi
done
exit $status
