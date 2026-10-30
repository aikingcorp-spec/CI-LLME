#!/usr/bin/env python3
"""Minimal RFC 5389 STUN Binding server for the netns NAT test.

Answers every Binding request with the sender's address in XOR-MAPPED-ADDRESS (IPv4 only).
Usage: stun-server.py LISTEN_IP PORT[,PORT]
"""
import asyncio, os, socket, struct, sys

MAGIC = 0x2112A442
BINDING_REQUEST, BINDING_SUCCESS = 0x0001, 0x0101
XOR_MAPPED_ADDRESS = 0x0020

def binding_response(data, addr):
    if len(data) < 20:
        return None
    msg_type, _length, cookie = struct.unpack("!HHI", data[:8])
    if msg_type != BINDING_REQUEST or cookie != MAGIC:
        return None
    ip, port = addr
    xport = port ^ (MAGIC >> 16)
    xip = struct.unpack("!I", socket.inet_aton(ip))[0] ^ MAGIC
    attr = struct.pack("!HHBBHI", XOR_MAPPED_ADDRESS, 8, 0, 1, xport, xip)
    return struct.pack("!HHI", BINDING_SUCCESS, len(attr), MAGIC) + data[8:20] + attr

class Server(asyncio.DatagramProtocol):
    def connection_made(self, transport): self.transport = transport
    def datagram_received(self, data, addr):
        response = binding_response(data, addr)
        if response:
            self.transport.sendto(response, addr)

async def main():
    loop = asyncio.get_running_loop()
    for port in (int(p) for p in sys.argv[2].split(",")):
        await loop.create_datagram_endpoint(Server, local_addr=(sys.argv[1], port))
    print(f"stun ready {os.getpid()}", flush=True)
    await asyncio.Event().wait()

asyncio.run(main())
