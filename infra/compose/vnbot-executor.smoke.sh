#!/usr/bin/env bash
# Offline failure-path checks only. Real Docker execution is a separate gate.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/vnbot-executor.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/source/infra/compose"
touch "$work/source/infra/compose/vnbot-preview.sh"
export PREVIEW_SMOKE_LOG="$work/calls"
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ -z ${DOCKER_HOST:-} && -z ${DOCKER_CONTEXT:-} && -z ${DOCKER_TLS_VERIFY:-} && -z ${DOCKER_CERT_PATH:-} ]]
[[ -z ${COMPOSE_FILE:-} && -z ${COMPOSE_ENV_FILES:-} ]]
printf '%s\n' "$*" >> "$PREVIEW_SMOKE_LOG"
if [[ "$*" == *'info --format'* ]]; then echo /fake-engine; fi
if [[ "$*" == *'config --quiet' && ${PREVIEW_SMOKE_CONFIG_FAIL:-0} == 1 ]]; then exit 17; fi
STUB
cat > "$work/bin/df" <<'STUB'
#!/usr/bin/env bash
[[ "$*" == '-Pk /fake-engine' || "$*" == '-Pk /var/lib/docker' ]] || exit 9
if [[ -n ${PREVIEW_SMOKE_DISK_SEQUENCE:-} ]]; then
  if [[ -f "$PREVIEW_SMOKE_DISK_SEQUENCE" ]]; then export PREVIEW_SMOKE_DISK_KIB=6291455; else touch "$PREVIEW_SMOKE_DISK_SEQUENCE"; fi
fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n'
printf 'fake 30000000 10000000 %s 33%% /fake-engine\n' "${PREVIEW_SMOKE_DISK_KIB:-20000000}"
STUB
cat > "$work/bin/awk" <<'STUB'
#!/usr/bin/env bash
if [[ "${2:-}" == /proc/meminfo ]]; then echo "${PREVIEW_SMOKE_MEMORY_KIB:-6000000}"; else exec /usr/bin/awk "$@"; fi
STUB
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"
export DOCKER_HOST=tcp://invalid.example:2375 DOCKER_CONTEXT=unrelated DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH=/fake
export COMPOSE_FILE=unrelated.yml COMPOSE_ENV_FILES=/fake
run() { bash "$root/vnbot-executor.sh" "$work/source" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
run validate
run up
[[ "$(tail -1 "$PREVIEW_SMOKE_LOG")" == *'up --detach --wait --wait-timeout 90' ]] || fail startup
for action in status stop; do run "$action"; done
run exec docker info
[[ "$(tail -1 "$PREVIEW_SMOKE_LOG")" == *'exec -T executor docker info' ]] || fail scope
for action in down prune restart; do
  if run "$action" > /dev/null 2>&1; then fail "accepted $action"; fi
done
if run up --volumes > /dev/null 2>&1; then fail 'accepted extra flags'; fi
for failure in disk memory config; do
  : > "$PREVIEW_SMOKE_LOG"
  case "$failure" in
    disk) export PREVIEW_SMOKE_DISK_KIB=8388607 ;;
    memory) export PREVIEW_SMOKE_MEMORY_KIB=5242879 ;;
    config) export PREVIEW_SMOKE_CONFIG_FAIL=1 ;;
  esac
  if run up > /dev/null 2>&1; then fail "accepted $failure failure"; fi
  if /usr/bin/awk '/up --detach/ {found=1} END {exit !found}' "$PREVIEW_SMOKE_LOG"; then fail 'started after failed preflight'; fi
  unset PREVIEW_SMOKE_DISK_KIB PREVIEW_SMOKE_MEMORY_KIB PREVIEW_SMOKE_CONFIG_FAIL
done
ln -s "$work/source" "$work/linked"
if bash "$root/vnbot-executor.sh" "$work/linked" up > /dev/null 2>&1; then fail 'accepted source symlink'; fi
echo 'Preview executor failure-path checks passed (offline only)'

cat > "$work/bin/dockerd-entrypoint.sh" <<'STUB'
#!/usr/bin/env bash
echo engine-started >> "$PREVIEW_SMOKE_LOG"
exec /usr/bin/sleep 60
STUB
chmod +x "$work/bin/dockerd-entrypoint.sh"
: > "$PREVIEW_SMOKE_LOG"
if PREVIEW_SMOKE_DISK_KIB=6291455 sh "$root/vnbot-executor-entrypoint.sh" > /dev/null 2>&1; then fail 'ignored disk floor'; fi
[[ ! -s "$PREVIEW_SMOKE_LOG" ]] || fail 'started engine below floor'
if PREVIEW_SMOKE_DISK_SEQUENCE="$work/disk-sequence" sh "$root/vnbot-executor-entrypoint.sh" > /dev/null 2>&1; then fail 'ignored falling disk space'; fi
echo 'Executor disk reserve checks passed (offline only)'
