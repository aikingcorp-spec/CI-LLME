#!/usr/bin/env python3
"""L4 forwarder for the netns test when the box has no iptables/NAT.

Listens on the root-namespace side of each machine's link and forwards UDP and TCP
byte-for-byte to the real TURN server. TURN state (allocations, relay addresses)
lives on the real server; this only stands in for the missing NAT.
On SIGUSR1 it prints one `stats {json}` line: per port, TCP connections opened/still open and
bytes each way, and UDP datagrams each way. That is wire-level evidence of which transport the
peers really used toward the TURN server.
Usage: turn-forwarder.py UPSTREAM_IP LISTEN_IP[,LISTEN_IP] PORT[,PORT]
"""
import asyncio, json, signal, sys

UP = sys.argv[1]
LISTEN = sys.argv[2].split(",")
PORTS = [int(p) for p in sys.argv[3].split(",")]

STATS = {}

def stat(key):
    return STATS.setdefault(key, {"opened": 0, "open": 0, "bytes_up": 0, "bytes_down": 0, "dgrams_up": 0, "dgrams_down": 0})

async def pipe(r, w, counter, field):
    try:
        while data := await r.read(65536):
            counter[field] += len(data)
            w.write(data); await w.drain()
    except Exception:
        pass
    finally:
        w.close()

def tcp_handler(port):
    async def handle(cr, cw):
        counter = stat(f"tcp:{port}")
        try:
            ur, uw = await asyncio.open_connection(UP, port)
        except Exception:
            cw.close(); return
        counter["opened"] += 1; counter["open"] += 1
        try:
            await asyncio.gather(pipe(cr, uw, counter, "bytes_up"), pipe(ur, cw, counter, "bytes_down"))
        finally:
            counter["open"] -= 1
    return handle

class Upstream(asyncio.DatagramProtocol):
    def __init__(self, front, client): self.front, self.client = front, client
    def datagram_received(self, data, _):
        stat(f"udp:{self.front.port}")["dgrams_down"] += 1
        self.front.transport.sendto(data, self.client)

class Front(asyncio.DatagramProtocol):
    def __init__(self, port): self.port, self.ups = port, {}
    def connection_made(self, t): self.transport = t
    def datagram_received(self, data, addr):
        stat(f"udp:{self.port}")["dgrams_up"] += 1
        up = self.ups.get(addr)
        if up is None:
            up = self.ups[addr] = asyncio.ensure_future(
                asyncio.get_running_loop().create_datagram_endpoint(
                    lambda: Upstream(self, addr), remote_addr=(UP, self.port)))
        up.add_done_callback(lambda f: f.result()[0].sendto(data))

async def main():
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGUSR1, lambda: print("stats " + json.dumps(STATS, sort_keys=True), flush=True))
    for ip in LISTEN:
        for port in PORTS:
            await asyncio.start_server(tcp_handler(port), ip, port)
            await loop.create_datagram_endpoint(lambda p=port: Front(p), local_addr=(ip, port))
    print("forwarder ready", flush=True)
    await asyncio.Event().wait()

asyncio.run(main())
