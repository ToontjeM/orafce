#!/bin/bash
# First start: initdb in Oracle-compatible mode and create the ACME role/database.
# Later starts: just run the server. The container is ephemeral by design.
set -e
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA"
  "$AS_BIN/initdb" -D "$PGDATA" -E UTF8 --redwood-like >/dev/null
  sed -i "s/^#listen_addresses = 'localhost'/listen_addresses = '*'/" "$PGDATA/postgresql.conf"
  { echo 'local all all trust'
    echo 'host  all all 0.0.0.0/0 scram-sha-256'
    echo 'host  all all ::/0      scram-sha-256'; } > "$PGDATA/pg_hba.conf"
  "$AS_BIN/pg_ctl" -D "$PGDATA" -l /tmp/init.log -w start >/dev/null
  "$AS_BIN/psql" -v ON_ERROR_STOP=1 -d edb -q <<SQL
ALTER ROLE enterprisedb IDENTIFIED BY enterprisedb;
CREATE USER acme IDENTIFIED BY acme SUPERUSER;
CREATE DATABASE acme OWNER acme;
SQL
  "$AS_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null
fi
exec "$AS_BIN/edb-postgres" -D "$PGDATA"
