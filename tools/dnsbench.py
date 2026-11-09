"""DNS speed test: times lookups against your current DNS, your router and well-known public resolvers."""
import json
import os
import random
import re
import socket
import statistics
import string
import struct
import subprocess
import threading
import time

PUBLIC = {
    "1.1.1.1": "Cloudflare", "1.0.0.1": "Cloudflare",
    "8.8.8.8": "Google", "8.8.4.4": "Google",
    "9.9.9.9": "Quad9", "149.112.112.112": "Quad9",
    "208.67.222.222": "OpenDNS", "208.67.220.220": "OpenDNS",
    "94.140.14.14": "AdGuard", "94.140.15.15": "AdGuard",
}
CANDIDATES = ["1.1.1.1", "8.8.8.8", "9.9.9.9", "208.67.222.222", "94.140.14.14"]
NOTES = {
    "Cloudflare": "Privacy-focused, doesn't log your IP.",
    "Google": "Fast almost everywhere.",
    "Quad9": "Blocks known malware and phishing domains.",
    "OpenDNS": "Optional family filtering with an account.",
    "AdGuard": "Blocks ads and trackers for every device that uses it.",
}
POPULAR = ["google.com", "youtube.com", "facebook.com", "instagram.com", "whatsapp.net", "wikipedia.org",
           "amazon.com", "netflix.com", "apple.com", "microsoft.com", "github.com", "cloudflare.com"]
UNCACHED_BASES = ["google.com", "reddit.com", "wikipedia.org", "amazon.com", "apple.com", "github.com"]


def query(server, name, timeout=1.5):
    """Send one A-record query over UDP; return the round trip in ms, or None on failure."""
    qid = random.randint(0, 0xFFFF)
    packet = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    packet += b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00"
    packet += struct.pack(">HH", 1, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        t0 = time.perf_counter()
        s.sendto(packet, (server, 53))
        while True:
            data, _ = s.recvfrom(2048)
            if len(data) >= 4 and struct.unpack(">H", data[:2])[0] == qid:
                rcode = data[3] & 0x0F
                # NXDOMAIN (3) is a valid answer for our random names; SERVFAIL/REFUSED are failures
                return round((time.perf_counter() - t0) * 1000, 1) if rcode in (0, 3) else None
    except OSError:
        return None
    finally:
        s.close()


def query_retry(server, name, timeout):
    """One retry: on Wi-Fi a single lost packet shouldn't count as the server failing."""
    ms = query(server, name, timeout)
    return ms if ms is not None else query(server, name, timeout)


def current_dns():
    out = subprocess.run(["scutil", "--dns"], capture_output=True, text=True).stdout
    first = out.split("resolver #2")[0]
    return [ip for ip in re.findall(r"nameserver\[\d+\] : (\d+\.\d+\.\d+\.\d+)", first)]


def rand_label():
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=12))


def bench(server):
    cached, fresh, fails, total = [], [], 0, 0
    warm = [query(server, name, timeout=1) for name in POPULAR[:4]]
    if all(ms is None for ms in warm):
        return {"cached": None, "uncached": None, "failPct": 100, "score": None, "unreachable": True}
    for name in POPULAR[4:]:  # first pass warms the cache, second is what browsing usually feels like
        query(server, name, timeout=1)
    for name in POPULAR:
        total += 1
        ms = query_retry(server, name, 1.5)
        if ms is None:
            fails += 1
        else:
            cached.append(ms)
        time.sleep(0.02)
    for base in UNCACHED_BASES:
        total += 1
        ms = query_retry(server, f"{rand_label()}.{base}", 2.5)
        if ms is None:
            fails += 1
        else:
            fresh.append(ms)
        time.sleep(0.02)
    med = lambda xs: round(statistics.median(xs), 1) if xs else None
    c, f = med(cached), med(fresh)
    fail_pct = round(100 * fails / total)
    score = None if c is None else round(0.7 * c + 0.3 * (f if f is not None else c * 3) + 3 * fail_pct, 1)
    return {"cached": c, "uncached": f, "failPct": fail_pct, "score": score}


class DnsBench:
    def __init__(self, data_dir, gateway_fn):
        self.file = os.path.join(data_dir, "dnstests.json")
        self.gateway_fn = gateway_fn
        self.running = False

    def history(self):
        try:
            with open(self.file) as f:
                return json.load(f)
        except (OSError, ValueError):
            return []

    def start(self):
        if self.running:
            return False
        self.running = True
        threading.Thread(target=self._run, daemon=True).start()
        return True

    def _run(self):
        try:
            current = current_dns()
            servers = {}
            for ip in current:
                servers[ip] = {"ip": ip, "name": PUBLIC.get(ip, "Your ISP / custom"), "current": True}
            gw = self.gateway_fn()
            if gw and gw not in servers:
                servers[gw] = {"ip": gw, "name": "Your router", "current": False}
            for ip in CANDIDATES:
                if ip not in servers and not any(PUBLIC.get(ip) == PUBLIC.get(c) for c in current):
                    servers[ip] = {"ip": ip, "name": PUBLIC[ip], "current": False}
            results = {}
            threads = [threading.Thread(target=lambda ip=ip: results.__setitem__(ip, bench(ip))) for ip in servers]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            rows = []
            for ip, meta in servers.items():
                rows.append({**meta, **results[ip], "note": NOTES.get(meta["name"])})
            rows.sort(key=lambda r: (r["score"] is None, r["score"] or 0))
            result = {"at": time.time(), "servers": rows, "currentIps": current}
            hist = self.history()
            hist.append(result)
            os.makedirs(os.path.dirname(self.file), exist_ok=True)
            with open(self.file, "w") as f:
                json.dump(hist[-20:], f)
        finally:
            self.running = False

    def state(self):
        hist = self.history()
        return {"running": self.running, "result": hist[-1] if hist else None,
                "history": [{"at": h["at"], "best": next((s["name"] for s in h["servers"] if s["score"] is not None), None)}
                            for h in hist]}
