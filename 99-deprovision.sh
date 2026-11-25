#!/bin/bash
# 99-deprovision.sh - stop and remove the Oracle Compatibility Lab (containers and volumes).
# The built images are kept so the next ./00-provision.sh is fast; remove them with
#   docker rmi orafce-demo-pg orafce-demo-epas orafce-demo-app

G=$(tput setaf 2); N=$(tput sgr0)
cd "$(dirname "$0")"

# compose validates the secret file and the interpolated variables even for 'down'
export EDB_TOKEN_FILE="${EDB_TOKEN_FILE:-$HOME/.tokens/edb_subscription_token}"
[ -e "$EDB_TOKEN_FILE" ] || export EDB_TOKEN_FILE=/dev/null

printf "${G}*** Removing the Oracle Compatibility Lab ***${N}\n"
docker compose down -v --remove-orphans
