#!/usr/bin/env bash
set -euo pipefail
NS_A=p2pA; NS_B=p2pB; NS_RA=p2pRA; NS_RB=p2pRB; NS_PUBLIC=p2pPublic
IP_A=10.77.0.11; IP_B=10.77.0.12; ROUTER_A=10.77.0.1; ROUTER_B=10.77.0.1
GW_ROOT_A=10.77.1.1; GW_A=10.77.1.2; GW_ROOT_B=10.77.2.1; GW_B=10.77.2.2
PUBLIC_IP=10.77.3.10; PUBLIC_A=10.77.3.11; PUBLIC_B=10.77.3.12
run() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
ns_exists() { run ip netns list | awk '{print $1}' | grep -qx "$1"; }
teardown() {
  for ns in "$NS_A" "$NS_B" "$NS_RA" "$NS_RB" "$NS_PUBLIC"; do if ns_exists "$ns"; then run ip netns del "$ns"; fi; done
  for link in p2pga p2pgb; do run ip link del "$link" 2>/dev/null || true; done
}
setup() {
  teardown
  command -v iptables >/dev/null 2>&1 || { echo "iptables is required for NAT topology" >&2; exit 77; }
  for ns in "$NS_A" "$NS_B" "$NS_RA" "$NS_RB" "$NS_PUBLIC"; do run ip netns add "$ns"; done
  run ip link add p2prA netns "$NS_A" type veth peer name p2prA netns "$NS_RA"
  run ip link add p2prB netns "$NS_B" type veth peer name p2prB netns "$NS_RB"
  run ip link add p2pga type veth peer name p2pga netns "$NS_RA"
  run ip link add p2pgb type veth peer name p2pgb netns "$NS_RB"
  run ip link add p2ppuba type veth peer name p2ppuba netns "$NS_PUBLIC"
  run ip link set p2ppuba netns "$NS_RA"
  run ip link add p2ppubb type veth peer name p2ppubb netns "$NS_PUBLIC"
  run ip link set p2ppubb netns "$NS_RB"
  run ip -n "$NS_PUBLIC" link set lo up
  run ip -n "$NS_PUBLIC" addr add "$PUBLIC_IP/24" dev p2ppuba
  run ip -n "$NS_PUBLIC" addr add "10.77.3.13/24" dev p2ppubb
  run ip -n "$NS_PUBLIC" link set p2ppuba up; run ip -n "$NS_PUBLIC" link set p2ppubb up
  run ip -n "$NS_A" link set lo up; run ip -n "$NS_A" addr add "$IP_A/24" dev p2prA; run ip -n "$NS_A" link set p2prA up; run ip -n "$NS_A" route add default via "$ROUTER_A"
  run ip -n "$NS_B" link set lo up; run ip -n "$NS_B" addr add "$IP_B/24" dev p2prB; run ip -n "$NS_B" link set p2prB up; run ip -n "$NS_B" route add default via "$ROUTER_B"
  run ip -n "$NS_RA" link set lo up; run ip -n "$NS_RA" addr add "$ROUTER_A/24" dev p2prA; run ip -n "$NS_RA" addr add "$GW_A/24" dev p2pga; run ip -n "$NS_RA" addr add "$PUBLIC_A/24" dev p2ppuba
  run ip -n "$NS_RA" link set p2prA up; run ip -n "$NS_RA" link set p2pga up; run ip -n "$NS_RA" link set p2ppuba up; run ip -n "$NS_RA" route add default via "$GW_ROOT_A"; run ip netns exec "$NS_RA" sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  run ip netns exec "$NS_RA" iptables -t nat -A POSTROUTING -o p2ppuba -j MASQUERADE; run ip netns exec "$NS_RA" iptables -t nat -A POSTROUTING -o p2pga -j MASQUERADE
  run ip -n "$NS_RB" link set lo up; run ip -n "$NS_RB" addr add "$ROUTER_B/24" dev p2prB; run ip -n "$NS_RB" addr add "$GW_B/24" dev p2pgb; run ip -n "$NS_RB" addr add "$PUBLIC_B/24" dev p2ppubb
  run ip -n "$NS_RB" link set p2prB up; run ip -n "$NS_RB" link set p2pgb up; run ip -n "$NS_RB" link set p2ppubb up; run ip -n "$NS_RB" route add default via "$GW_ROOT_B"; run ip netns exec "$NS_RB" sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  run ip netns exec "$NS_RB" iptables -t nat -A POSTROUTING -o p2ppubb -j MASQUERADE; run ip netns exec "$NS_RB" iptables -t nat -A POSTROUTING -o p2pgb -j MASQUERADE
  run ip addr add "$GW_ROOT_A/24" dev p2pga; run ip addr add "$GW_ROOT_B/24" dev p2pgb; run ip link set p2pga up; run ip link set p2pgb up
}
status() { for ns in "$NS_A" "$NS_B" "$NS_RA" "$NS_RB" "$NS_PUBLIC"; do echo "== $ns"; run ip netns exec "$ns" ip -br -4 addr; run ip netns exec "$ns" ip route; done; }
case "${1:-}" in setup) setup ;; teardown) teardown ;; status) status ;; *) echo "usage: $0 setup|teardown|status"; exit 2 ;; esac
