#!/usr/bin/env bash
# Recreate a throwaway local database with the Supabase shim + all migrations (+ demo data if SEED=1).
# Connects over TCP, so it works the same on a laptop and in CI.
#   PGHOST/PGPORT/PGUSER/PGPASSWORD default to 127.0.0.1:5432 postgres/postgres
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DB:-openbench_fix}"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
PSQL="psql -v ON_ERROR_STOP=1 -q -X"
dropdb --if-exists "$DB"
createdb "$DB"
$PSQL -d "$DB" -f "$DIR/tests/supabase_shim.sql"
for f in "$DIR"/migrations/*.sql; do
  $PSQL -d "$DB" -f "$f"
done
if [ "${SEED:-0}" = "1" ]; then $PSQL -d "$DB" -f "$DIR/tests/seed_local_users.sql" >/dev/null; fi
echo "ok: $DB ready"
