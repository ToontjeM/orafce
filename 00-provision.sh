#!/bin/bash
# 00-provision.sh - build and start the Oracle Compatibility Lab:
#   oracle  Oracle Database Free with the ACME source schema
#   pg      PostgreSQL 18 + orafce           (route A target)
#   epas    EPAS 18, Oracle-compatible mode  (route B target)
#   app     the web UI, with ora2pg and EDB Migration Toolkit inside
# The first start takes a while: Oracle creates its database (a few minutes) and the
# images are built (about 10 minutes the first time, the EDB packages are large).

G=$(tput setaf 2); R=$(tput setaf 1); Y=$(tput setaf 3); N=$(tput sgr0)
cd "$(dirname "$0")"

command -v docker >/dev/null 2>&1       || { printf "${R}*** Docker is not installed ***${N}\n" >&2; exit 1; }
docker info >/dev/null 2>&1             || { printf "${R}*** The Docker daemon is not running ***${N}\n" >&2; exit 1; }
docker compose version >/dev/null 2>&1  || { printf "${R}*** Docker Compose v2 is required ***${N}\n" >&2; exit 1; }

# The EDB subscription token is needed at build time (EPAS, Migration Toolkit). It is passed
# as a BuildKit secret, so it never lands in an image layer.
export EDB_TOKEN_FILE="${EDB_TOKEN_FILE:-$HOME/.tokens/edb_subscription_token}"
if [ ! -s "$EDB_TOKEN_FILE" ]; then
  printf "${R}ERROR: %s not found.${N}\n" "$EDB_TOKEN_FILE"
  echo "Put your EDB subscription token there (https://www.enterprisedb.com/accounts/profile)."
  exit 1
fi

is_port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
random_free_port() {
  local candidate
  for _ in $(seq 1 50); do
    candidate=$(( (RANDOM % 20000) + 20000 ))
    if is_port_free "$candidate"; then echo "$candidate"; return 0; fi
  done
  return 1
}
# Conventional port if it is free, otherwise a random one, so several demos can run side by side.
pick_port() { if is_port_free "$1"; then echo "$1"; else random_free_port; fi; }

WEBAPP_PORT=$(random_free_port)  || { printf "${R}*** No free port for the web UI ***${N}\n"; exit 1; }
PG_PORT=$(pick_port 5432)        || exit 1
EPAS_PORT=$(pick_port 5444)      || exit 1
ORACLE_PORT=$(pick_port 1521)    || exit 1

# Oracle Database Free: reuse an image that is already on this machine, otherwise pull Oracle's.
if [ -z "$ORACLE_IMAGE" ]; then
  for img in container-registry.oracle.com/database/free:latest hrplus/oracle-database:23.26-free; do
    if docker image inspect "$img" >/dev/null 2>&1; then ORACLE_IMAGE=$img; break; fi
  done
  ORACLE_IMAGE=${ORACLE_IMAGE:-container-registry.oracle.com/database/free:latest}
fi
export ORACLE_IMAGE WEBAPP_PORT PG_PORT EPAS_PORT ORACLE_PORT

printf "${G}*** Oracle: %s (port %s), PostgreSQL+orafce: %s, EPAS: %s, Web UI: %s ***${N}\n" "$ORACLE_IMAGE" "$ORACLE_PORT" "$PG_PORT" "$EPAS_PORT" "$WEBAPP_PORT"

printf "${G}*** Building images and starting the containers ***${N}\n"
docker compose up -d --build || exit 1

printf "${G}*** Waiting for the web UI ***${N}\n"
for _ in $(seq 1 90); do
  curl -sf "http://localhost:${WEBAPP_PORT}/api/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "http://localhost:${WEBAPP_PORT}/api/health" >/dev/null 2>&1 || {
  printf "${R}*** The web UI did not start: check 'docker compose logs app' ***${N}\n"; exit 1; }

printf "${G}*** Waiting for Oracle to create and open its database (about 4 minutes on the first start) ***${N}\n"
for i in $(seq 1 300); do
  if curl -sf "http://localhost:${WEBAPP_PORT}/api/status" | grep -q '"oracle":{"up":true'; then
    printf "\n${G}*** Ready: http://localhost:%s ***${N}\n" "$WEBAPP_PORT"
    cat <<MSG
    Oracle (source)        sqlplus acme/acme@//localhost:${ORACLE_PORT}/FREEPDB1
    PostgreSQL + orafce    psql -h localhost -p ${PG_PORT} -U acme acme        (password: acme)
    EPAS (Oracle mode)     psql -h localhost -p ${EPAS_PORT} -U acme acme      (password: acme)

    Open the web UI and start at the Intro tab. Tear down with ./99-deprovision.sh
MSG
    exit 0
  fi
  printf "."
  sleep 3
done
printf "\n${R}*** Timed out waiting for Oracle: check 'docker compose logs oracle' ***${N}\n"
exit 1
