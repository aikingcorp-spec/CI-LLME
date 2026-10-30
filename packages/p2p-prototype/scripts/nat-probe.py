#!/usr/bin/env python3
"""Classify NAT mapping behaviour from inside a peer namespace.

Sends a STUN Binding request from ONE local socket to two ports of the same server and prints a
JSON line. The same mapped port for both destinations means endpoint-independent mapping; different
ports mean endpoint-dependent (symmetric) mapping.
Usage: nat-probe.py SERVER_IP PORT1 PORT2
"""
import json, os, socket, struct, sys

MAGIC = 0x2112A442
XOR_MAPPED_ADDRESS = 0x0020

def mapped_address(data, transaction_id):
    if len(data) < 20 or data[8:20] != transaction_id or struct.unpack("!H", data[:2])[0] != 0x0101:
        return None
    end = 20 + struct.unpack("!H", data[2:4])[0]
    at = 20
    while at + 4 <= end:
        attr_type, length = struct.unpack("!HH", data[at:at + 4])
        if attr_type == XOR_MAPPED_ADDRESS and length >= 8:
            port, ip = struct.unpack("!HI", data[at + 6:at + 12])
            return f"{socket.inet_ntoa(struct.pack('!I', ip ^ MAGIC))}:{port ^ (MAGIC >> 16)}"
        at += 4 + length + (-length % 4)
    return None

def probe(sock, server, port):
    for _ in range(3):
        transaction_id = os.urandom(12)
        sock.sendto(struct.pack("!HHI", 0x0001, 0, MAGIC) + transaction_id, (server, port))
        try:
            while True:
                data, _ = sock.recvfrom(2048)
                if (found := mapped_address(data, transaction_id)):
                    return found
        except socket.timeout:
            continue
    return None

server, ports = sys.argv[1], [int(p) for p in sys.argv[2:4]]
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(1)
sock.bind(("0.0.0.0", 0))
mapped = {str(port): probe(sock, server, port) for port in ports}
values = list(mapped.values())
if None in values:
    print(json.dumps({"server": server, "mapped": mapped, "error": "no response"}))
    sys.exit(1)
mapping = "endpoint-independent" if values[0].rsplit(":", 1)[1] == values[1].rsplit(":", 1)[1] else "endpoint-dependent"
print(json.dumps({"server": server, "localPort": sock.getsockname()[1], "mapped": mapped, "mapping": mapping}))
