#!/usr/bin/env bash
# Usage: PGURL=postgres://user@host:port/db scripts/sql-tests/run-daily-goals-sql.sh
# Requires a THROWAWAY database (the test drops/creates auth + profiles stubs).
set -euo pipefail
cd "$(dirname "$0")/../.."
psql "${PGURL:?set PGURL to a throwaway Postgres}" -X -q -t -A -f scripts/sql-tests/daily_goals.test.sql
