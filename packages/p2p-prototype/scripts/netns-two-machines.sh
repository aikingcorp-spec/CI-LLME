#!/usr/bin/env bash
set -euo pipefail
TOPOLOGY="${P2P_TOPOLOGY:-nat}"
# The two topologies share nothing, so a NAT run and a routed run (or another worktree's) can coexist:
# names and addresses are keyed off the topology, and teardown only ever touches its own.
if [ "$TOPOLOGY" = routed ]; then
  P=p2p; NET=10.77; NS_PUBLIC=p2pPublic
else
  P=pn; NET=10.78; NS_PUBLIC=pnPub
fi
NS_A=${P}A; NS_B=${P}B; NS_RA=${P}RA; NS_RB=${P}RB; NS_R=${P}R
IF_RA=${P}rA; IF_RB=${P}rB; IF_GA=${P}ga; IF_GB=${P}gb; IF_PUBA=${P}puba; IF_PUBB=${P}pubb
IP_A=$NET.0.11; IP_B=$NET.0.12; ROUTER_A=$NET.0.1; ROUTER_B=$NET.0.1
GW_ROOT_A=$NET.1.1; GW_A=$NET.1.2; GW_ROOT_B=$NET.2.1; GW_B=$NET.2.2
PUBLIC_IP=$NET.3.10; PUBLIC_A=$NET.3.11; PUBLIC_B=$NET.3.12
run() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
ns_exists() { run ip netns list | awk '{print $1}' | grep -qx "$1"; }
teardown() {
  for ns in "$NS_A" "$NS_B" "$NS_RA" "$NS_RB" "$NS_PUBLIC" "$NS_R"; do if ns_exists "$ns"; then run ip netns del "$ns"; fi; done
  for link in "$IF_GA" "$IF_GB"; do run ip link del "$link" 2>/dev/null || true; done
}
# iptables: P2P_IPTABLES is a command, or the path of an xtables-*-multi binary (then "iptables" is
# appended). P2P_IPT_LIBDIR points the extracted binary at its shared libraries and xtables modules.
IPTABLES="${P2P_IPTABLES:-iptables}"
ipt_cmd() {
  IPT_CMD=("$IPTABLES")
  case "$IPTABLES" in *-multi) IPT_CMD+=(iptables) ;; esac
  if [ -n "${P2P_IPT_LIBDIR:-}" ]; then
    IPT_CMD=(env "LD_LIBRARY_PATH=$P2P_IPT_LIBDIR" "XTABLES_LIBDIR=$P2P_IPT_LIBDIR/xtables" "${IPT_CMD[@]}")
  fi
}
ipt() { local ns=$1; shift; ipt_cmd; run ip netns exec "$ns" "${IPT_CMD[@]}" "$@"; }
check() { ipt_cmd; { command -v "$IPTABLES" >/dev/null 2>&1 || [ -x "$IPTABLES" ]; } && run "${IPT_CMD[@]}" -V >/dev/null 2>&1 || { echo "iptables is required for NAT topology" >&2; exit 77; }; }
# One NAT router. NAT_TYPE cone keeps the source port (endpoint-independent mapping; conntrack only
# accepts replies from the exact address and port, so filtering is port-restricted). symmetric
# picks a new random port per 5-tuple (endpoint-dependent mapping). Unsolicited inbound is dropped.
NAT_TYPE="${P2P_NAT_TYPE:-cone}"
nat_router() {
  local ns=$1 lan=$2 uplink=$3 pub=$4 masq=(MASQUERADE)
  case "$NAT_TYPE" in cone) ;; symmetric) masq+=(--random-fully) ;; *) echo "P2P_NAT_TYPE must be cone or symmetric" >&2; exit 2 ;; esac
  ipt "$ns" -t nat -A POSTROUTING -o "$pub" -j "${masq[@]}"
  ipt "$ns" -t nat -A POSTROUTING -o "$uplink" -j "${masq[@]}"
  ipt "$ns" -P FORWARD DROP
  ipt "$ns" -A FORWARD -i "$lan" -m conntrack --ctstate NEW,ESTABLISHED,RELATED -j ACCEPT
  ipt "$ns" -A FORWARD -o "$lan" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # Dropping unsolicited packets to the router itself keeps them out of conntrack, so a probe
  # from the other side cannot pre-claim a mapping.
  ipt "$ns" -P INPUT DROP
  ipt "$ns" -A INPUT -i lo -j ACCEPT
  ipt "$ns" -A INPUT -i "$lan" -j ACCEPT
  ipt "$ns" -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
}
# NAT topology: A and B share the private subnet $NET.0.0/24 behind separate NAT routers, so a host
# candidate can never reach the other side. The routers meet on the public bridge $NET.3.0/24
# (STUN at $NET.3.10) and each keeps an uplink to the root namespace (gateway, TURN forwarder).
setup() {
  teardown
  check
  for ns in "$NS_A" "$NS_B" "$NS_RA" "$NS_RB" "$NS_PUBLIC"; do run ip netns add "$ns"; done
  run ip link add $IF_RA netns "$NS_A" type veth peer name $IF_RA netns "$NS_RA"
  run ip link add $IF_RB netns "$NS_B" type veth peer name $IF_RB netns "$NS_RB"
  run ip link add $IF_GA type veth peer name $IF_GA netns "$NS_RA"
  run ip link add $IF_GB type veth peer name $IF_GB netns "$NS_RB"
  run ip link add $IF_PUBA netns "$NS_RA" type veth peer name $IF_PUBA netns "$NS_PUBLIC"
  run ip link add $IF_PUBB netns "$NS_RB" type veth peer name $IF_PUBB netns "$NS_PUBLIC"
  run ip -n "$NS_PUBLIC" link set lo up
  run ip -n "$NS_PUBLIC" link add br0 type bridge
  run ip -n "$NS_PUBLIC" link set $IF_PUBA master br0; run ip -n "$NS_PUBLIC" link set $IF_PUBB master br0
  run ip -n "$NS_PUBLIC" addr add "$PUBLIC_IP/24" dev br0
  run ip -n "$NS_PUBLIC" link set br0 up; run ip -n "$NS_PUBLIC" link set $IF_PUBA up; run ip -n "$NS_PUBLIC" link set $IF_PUBB up
  run ip -n "$NS_A" link set lo up; run ip -n "$NS_A" addr add "$IP_A/24" dev $IF_RA; run ip -n "$NS_A" link set $IF_RA up; run ip -n "$NS_A" route add default via "$ROUTER_A"
  run ip -n "$NS_B" link set lo up; run ip -n "$NS_B" addr add "$IP_B/24" dev $IF_RB; run ip -n "$NS_B" link set $IF_RB up; run ip -n "$NS_B" route add default via "$ROUTER_B"
  run ip -n "$NS_RA" link set lo up; run ip -n "$NS_RA" addr add "$ROUTER_A/24" dev $IF_RA; run ip -n "$NS_RA" addr add "$GW_A/24" dev $IF_GA; run ip -n "$NS_RA" addr add "$PUBLIC_A/24" dev $IF_PUBA
  run ip -n "$NS_RA" link set $IF_RA up; run ip -n "$NS_RA" link set $IF_GA up; run ip -n "$NS_RA" link set $IF_PUBA up; run ip -n "$NS_RA" route add default via "$GW_ROOT_A"; run ip netns exec "$NS_RA" sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  nat_router "$NS_RA" $IF_RA $IF_GA $IF_PUBA
  run ip -n "$NS_RB" link set lo up; run ip -n "$NS_RB" addr add "$ROUTER_B/24" dev $IF_RB; run ip -n "$NS_RB" addr add "$GW_B/24" dev $IF_GB; run ip -n "$NS_RB" addr add "$PUBLIC_B/24" dev $IF_PUBB
  run ip -n "$NS_RB" link set $IF_RB up; run ip -n "$NS_RB" link set $IF_GB up; run ip -n "$NS_RB" link set $IF_PUBB up; run ip -n "$NS_RB" route add default via "$GW_ROOT_B"; run ip netns exec "$NS_RB" sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  nat_router "$NS_RB" $IF_RB $IF_GB $IF_PUBB
  run ip addr add "$GW_ROOT_A/24" dev $IF_GA; run ip addr add "$GW_ROOT_B/24" dev $IF_GB; run ip link set $IF_GA up; run ip link set $IF_GB up
}
# Routed topology without NAT (no iptables needed): A and B sit on different subnets behind one
# router namespace, so host candidates must cross an L3 hop. Each machine also has a direct link
# to the root namespace, which runs the gateway and the optional TURN relay.
setup_routed() {
  teardown
  for ns in "$NS_A" "$NS_B" "$NS_R"; do run ip netns add "$ns"; done
  run ip link add $IF_RA netns "$NS_A" type veth peer name $IF_RA netns "$NS_R"
  run ip link add $IF_RB netns "$NS_B" type veth peer name $IF_RB netns "$NS_R"
  run ip link add $IF_GA type veth peer name $IF_GA netns "$NS_A"
  run ip link add $IF_GB type veth peer name $IF_GB netns "$NS_B"
  run ip -n "$NS_R" link set lo up
  run ip -n "$NS_R" addr add $NET.10.1/24 dev $IF_RA; run ip -n "$NS_R" link set $IF_RA up
  run ip -n "$NS_R" addr add $NET.20.1/24 dev $IF_RB; run ip -n "$NS_R" link set $IF_RB up
  run ip netns exec "$NS_R" sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  run ip -n "$NS_A" link set lo up; run ip -n "$NS_A" addr add $NET.10.11/24 dev $IF_RA; run ip -n "$NS_A" link set $IF_RA up
  run ip -n "$NS_A" addr add "$GW_A/24" dev $IF_GA; run ip -n "$NS_A" link set $IF_GA up; run ip -n "$NS_A" route add default via $NET.10.1
  run ip -n "$NS_B" link set lo up; run ip -n "$NS_B" addr add $NET.20.12/24 dev $IF_RB; run ip -n "$NS_B" link set $IF_RB up
  run ip -n "$NS_B" addr add "$GW_B/24" dev $IF_GB; run ip -n "$NS_B" link set $IF_GB up; run ip -n "$NS_B" route add default via $NET.20.1
  run ip addr add "$GW_ROOT_A/24" dev $IF_GA; run ip addr add "$GW_ROOT_B/24" dev $IF_GB; run ip link set $IF_GA up; run ip link set $IF_GB up
}
status() { for ns in "$NS_A" "$NS_B" "$NS_RA" "$NS_RB" "$NS_PUBLIC" "$NS_R"; do ns_exists "$ns" || continue; echo "== $ns"; run ip netns exec "$ns" ip -br -4 addr; run ip netns exec "$ns" ip route; done; }
case "${1:-}" in check) [ "$TOPOLOGY" = routed ] || check ;; setup) if [ "$TOPOLOGY" = routed ]; then setup_routed; else setup; fi ;; teardown) teardown ;; status) status ;; *) echo "usage: $0 setup|teardown|status|check"; exit 2 ;; esac
