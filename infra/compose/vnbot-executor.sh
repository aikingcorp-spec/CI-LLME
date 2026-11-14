#!/usr/bin/env bash
# Operate only the dedicated preview's nested engine. No outer Docker socket enters it.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ $# -lt 2 ]]; then
  echo "Usage: bash infra/compose/vnbot-executor.sh SOURCE_DIR {validate|up|status|stop|exec COMMAND...}" >&2
  exit 2
fi
source_dir="$1"
action="$2"
shift 2
case "$action" in
  validate|up|status|stop) [[ $# == 0 ]] || exit 2 ;;
  exec) [[ $# -gt 0 ]] || exit 2 ;;
  *) exit 2 ;;
esac
if [[ ! -d "$source_dir" || -L "$source_dir" || ! -f "$source_dir/infra/compose/vnbot-preview.sh" ]]; then
  echo "A dedicated tracked-source export is required." >&2
  exit 2
fi
export VNBOT_PREVIEW_SOURCE_DIR="$(cd "$source_dir" && pwd)"
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
compose=(docker --context default compose --project-name vnbot-040-preview
  --env-file /dev/null -f "$root/infra/compose/docker-compose.vnbot-executor.yml")
case "$action" in
  validate) exec "${compose[@]}" config --quiet ;;
  up)
    "${compose[@]}" config --quiet
    # Check the actual daemon filesystem, not the source export's filesystem.
    docker_root="$(docker --context default info --format '{{.DockerRootDir}}')"
    available_kib="$(df -Pk "$docker_root" | awk 'END {print $4}')"
    memory_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
    if [[ ! "$available_kib" =~ ^[0-9]+$ || "$available_kib" -lt 8388608 ]]; then
      echo "Preview requires at least 8 GiB available on the engine filesystem." >&2
      exit 1
    fi
    if [[ ! "$memory_kib" =~ ^[0-9]+$ || "$memory_kib" -lt 5242880 ]]; then
      echo "Preview requires at least 5 GiB available RAM; swap is not capacity." >&2
      exit 1
    fi
    exec "${compose[@]}" up --detach --wait --wait-timeout 90
    ;;
  status) exec "${compose[@]}" ps ;;
  stop) exec "${compose[@]}" stop ;;
  exec) exec "${compose[@]}" exec -T executor "$@" ;;
esac
