#!/usr/bin/env bash
# Only operates the dedicated 0.4.0 source-build preview; never deletes volumes.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
usage() {
  echo "Usage: bash infra/compose/vnbot-preview.sh ENV_FILE {validate|up|stop|status|logs}" >&2
}
if [[ $# != 2 ]]; then usage; exit 2; fi
env_file="$1"
action="$2"
case "$action" in
  validate|up|stop|status|logs) ;;
  *) usage; exit 2 ;;
esac
if [[ ! -f "$env_file" || -L "$env_file" ]]; then
  echo "A dedicated regular preview environment file is required." >&2
  exit 2
fi
env_file="$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")"
if ! command -v docker >/dev/null; then
  echo "Docker Engine and Compose >= 2.24.4 are required." >&2
  exit 1
fi
# Do not let ambient Compose settings select another stack or an external Docker host.
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES DOCKER_HOST DOCKER_CONTEXT
compose=(docker --context default compose --project-name vnbot-040-preview
  --env-file "$env_file"
  -f "$root/infra/compose/docker-compose.yml"
  -f "$root/infra/compose/docker-compose.vnbot-preview.yml")
case "$action" in
  # --quiet validates without printing expanded secrets.
  validate) exec "${compose[@]}" config --quiet ;;
  up)
    "${compose[@]}" config --quiet
    exec "${compose[@]}" up --build --detach --wait
    ;;
  stop) exec "${compose[@]}" stop ;;
  status) exec "${compose[@]}" ps ;;
  logs) exec "${compose[@]}" logs --tail 100 ;;
esac
