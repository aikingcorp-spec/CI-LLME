#!/bin/sh
# Bound disk consumption on the shared host. Only this nested engine is stopped.
set -eu
check_space() {
  available_kib="$(df -Pk /var/lib/docker | awk 'END {print $4}')"
  case "$available_kib" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$available_kib" -ge 6291456 ]
}
if ! check_space; then
  echo 'Preview engine refused: keep at least 6 GiB disk free.' >&2
  exit 1
fi
dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock &
engine_pid=$!
stop_engine() {
  kill -TERM "$engine_pid" 2>/dev/null || true
  wait "$engine_pid" || true
}
trap 'stop_engine; exit 143' TERM INT
while kill -0 "$engine_pid" 2>/dev/null; do
  if ! check_space; then
    echo 'Preview engine stopped: disk reserve reached or unavailable.' >&2
    stop_engine
    exit 1
  fi
  sleep 5 &
  wait $! || true
done
wait "$engine_pid"
