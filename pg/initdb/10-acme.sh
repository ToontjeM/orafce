#!/bin/bash
# Prepare the migration target: an empty ACME database with orafce installed.
set -e
psql -v ON_ERROR_STOP=1 -U postgres <<SQL
CREATE ROLE acme LOGIN SUPERUSER PASSWORD 'acme';
CREATE DATABASE acme OWNER acme;
SQL
psql -v ON_ERROR_STOP=1 -U postgres -d acme -c "CREATE EXTENSION orafce;"
# the search_path that ora2pg itself emits: target schema first, then orafce's oracle schema
psql -v ON_ERROR_STOP=1 -U postgres -c "ALTER DATABASE acme SET search_path = acme, oracle, public;"
