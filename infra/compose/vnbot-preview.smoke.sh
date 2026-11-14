#!/usr/bin/env bash
# Offline launcher contract only; does not prove a running Docker stack.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/vnbot-preview.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
touch "$work/preview.env"
export PREVIEW_SMOKE_LOG="$work/calls"
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ -z ${COMPOSE_FILE:-} && -z ${COMPOSE_PROJECT_NAME:-} && -z ${COMPOSE_PROFILES:-} ]]
[[ -z ${DOCKER_HOST:-} && -z ${DOCKER_CONTEXT:-} ]]
printf '%s\n' "$*" >> "$PREVIEW_SMOKE_LOG"
if [[ "$*" == *'config --quiet' && ${PREVIEW_SMOKE_CONFIG_FAIL:-0} == 1 ]]; then exit 17; fi
STUB
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH"
export COMPOSE_FILE=unrelated.yml COMPOSE_PROJECT_NAME=unrelated COMPOSE_PROFILES=unrelated
export DOCKER_HOST=tcp://invalid.example:2375 DOCKER_CONTEXT=unrelated
fail() { echo "FAIL: $*" >&2; exit 1; }
run() { bash "$root/vnbot-preview.sh" "$work/preview.env" "$@"; }
run validate
expected="--context default compose --project-name vnbot-040-preview --env-file $work/preview.env -f $root/docker-compose.yml -f $root/docker-compose.vnbot-preview.yml"
[[ "$(cat "$PREVIEW_SMOKE_LOG")" == "$expected config --quiet" ]] || fail "validation target differs"
: > "$PREVIEW_SMOKE_LOG"
run up
[[ "$(cat "$PREVIEW_SMOKE_LOG")" == "$expected config --quiet"$'\n'"$expected up --build --detach --wait" ]] || fail "startup target differs"
for action in stop status logs; do run "$action"; done
for action in down prune restart; do
  if run "$action" > /dev/null 2>&1; then fail "accepted unsupported action"; fi
done
if run up --volumes > /dev/null 2>&1; then fail "accepted extra arguments"; fi
: > "$PREVIEW_SMOKE_LOG"
if PREVIEW_SMOKE_CONFIG_FAIL=1 run up; then fail "started after invalid config"; fi
[[ "$(cat "$PREVIEW_SMOKE_LOG")" == "$expected config --quiet" ]] || fail "continued after invalid config"
rm "$work/preview.env"
if run validate > /dev/null 2>&1; then fail "accepted missing environment"; fi
touch "$work/real.env"
ln -s "$work/real.env" "$work/preview.env"
if run validate > /dev/null 2>&1; then fail "accepted symlink environment"; fi
echo "VNBot preview launcher smoke passed (offline command contract only)"
