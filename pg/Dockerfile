# Community PostgreSQL 18 + the orafce extension (from the PGDG repo that the
# official image already has configured). This is "path A": stock Postgres.
FROM postgres:18-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-18-orafce \
 && rm -rf /var/lib/apt/lists/*
COPY initdb/ /docker-entrypoint-initdb.d/
