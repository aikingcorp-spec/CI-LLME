#!/usr/bin/env bash
set -euo pipefail

NS_A=p2pA
NS_B=p2pB
LINK_AB=p2pab
LINK_GW_A=p2pga
LINK_GW_B=p2pgb
IP_A=10.77.0.11
IP_B=10.77.0.12
GW_ROOT_A=10.77.1.1
GW_A=10.77.1.2
GW_ROOT_B=10.77.2.1
GW_B=10.77.2.2

usage() {
  cat <<EOF
usage: $0 setup|teardown|status

Two simulated machines on one host.

  $NS_A  $IP_A/24 on $LINK_AB, gateway reachable at $GW_ROOT_A
  $NS_B  $IP_B/24 on $LINK_AB, gateway reachable at $GW_ROOT_B

$NS_A and $NS_B are joined by a direct veth pair and have no route through the root
namespace, so they reach each other only at $IP_A and $IP_B. The gateway runs in the root
namespace and listens on 0.0.0.0. Needs passwordless sudo; setup is idempotent.
EOF
}

run() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi
}

teardown() {
  for ns in "$NS_A" "$NS_B"; do
    if run ip netns list | grep -q "^$ns\b"; then run ip netns del "$ns"; fi
  done
  for link in "$LINK_GW_A" "$LINK_GW_B"; do
    run ip link del "$link" 2>/dev/null || true
  done
}

side() {
  local ns=$1 ab_ip=$2 link=$3 gw_ip=$4 gw_link=$5 root_ip=$6
  run ip -n "$ns" link set lo up
  run ip -n "$ns" addr add "$ab_ip/24" dev "$LINK_AB"
  run ip -n "$ns" link set "$LINK_AB" up
  run ip -n "$ns" addr add "$gw_ip/24" dev "$link"
  run ip -n "$ns" link set "$link" up
  run ip addr add "$root_ip/24" dev "$gw_link"
  run ip link set "$gw_link" up
}

setup() {
  teardown
  run ip netns add "$NS_A"
  run ip netns add "$NS_B"
  run ip link add "$LINK_AB" netns "$NS_A" type veth peer name "$LINK_AB" netns "$NS_B"
  run ip link add "$LINK_GW_A" type veth peer name gw0 netns "$NS_A"
  run ip link add "$LINK_GW_B" type veth peer name gw0 netns "$NS_B"
  side "$NS_A" "$IP_A" gw0 "$GW_A" "$LINK_GW_A" "$GW_ROOT_A"
  side "$NS_B" "$IP_B" gw0 "$GW_B" "$LINK_GW_B" "$GW_ROOT_B"
}

status() {
  for ns in "$NS_A" "$NS_B"; do
    echo "== $ns"
    run ip netns exec "$ns" ip -br -4 addr
    run ip netns exec "$ns" ip route
  done
}

case "${1:-}" in
  setup) setup ;;
  teardown) teardown ;;
  status) status ;;
  *) usage; exit 2 ;;
esac
