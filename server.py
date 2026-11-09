#!/usr/bin/env python3
"""Wi-Fi Spot Finder: streams live Wi-Fi signal + router ping to a local web page.

Run:  python3 server.py      then open http://localhost:8765
"""
import collections
import json
import os
import re
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLER_SRC = os.path.join(HERE, "wifisampler.swift")
SAMPLER = os.path.join(HERE, "wifisampler")
DATA_DIR = os.path.expanduser("~/Library/Application Support/Wi-Fi Spot Finder")
SPOTS_FILE = os.environ.get("SPOTS_FILE", os.path.join(DATA_DIR, "spots.json"))
PORT = int(os.environ.get("PORT", "8765"))

lock = threading.Lock()
wifi = {}
pings = collections.deque(maxlen=60)  # (timestamp, ms or None for a lost packet)
gateway = None


def ensure_sampler():
    if not os.path.exists(SAMPLER_SRC):  # bundled app ships a prebuilt sampler
        return
    if not os.path.exists(SAMPLER) or os.path.getmtime(SAMPLER) < os.path.getmtime(SAMPLER_SRC):
        print("Compiling Wi-Fi sampler (one-time)…")
        subprocess.run(["swiftc", "-O", SAMPLER_SRC, "-o", SAMPLER], check=True)


def wifi_loop():
    while True:
        proc = subprocess.Popen([SAMPLER, "0.5"], stdout=subprocess.PIPE, text=True)
        for line in proc.stdout:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            d["t"] = time.time()
            with lock:
                wifi.clear()
                wifi.update(d)
        proc.wait()
        time.sleep(1)


def find_gateway():
    out = subprocess.run(["route", "-n", "get", "default"], capture_output=True, text=True).stdout
    m = re.search(r"gateway:\s*(\S+)", out)
    return m.group(1) if m else None


def ping_loop():
    global gateway
    while True:
        gateway = find_gateway()
        if not gateway:
            time.sleep(2)
            continue
        proc = subprocess.Popen(
            ["ping", "-i", "0.5", gateway],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        started = time.time()
        for line in proc.stdout:
            now = time.time()
            m = re.search(r"time=([\d.]+) ms", line)
            if m:
                with lock:
                    pings.append((now, float(m.group(1))))
            elif "timeout" in line or "unreachable" in line.lower() or "No route" in line:
                with lock:
                    pings.append((now, None))
            # re-check the gateway every minute in case you switched networks
            if now - started > 60 and find_gateway() != gateway:
                proc.kill()
                break
        proc.wait()
        time.sleep(0.5)


def snapshot():
    with lock:
        d = dict(wifi)
        items = list(pings)
    recent = [p for p in items if time.time() - p[0] < 10]
    ok = [ms for _, ms in recent if ms is not None]
    d["gateway"] = gateway
    d["ping"] = items[-1][1] if items and time.time() - items[-1][0] < 3 else None
    d["pingAvg"] = round(sum(ok) / len(ok), 1) if ok else None
    d["jitter"] = round(sum(abs(a - b) for a, b in zip(ok, ok[1:])) / (len(ok) - 1), 1) if len(ok) > 1 else None
    d["loss"] = round(100 * (len(recent) - len(ok)) / len(recent)) if recent else None
    return d


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif self.path == "/api/spots":
            data = b"[]"
            if os.path.exists(SPOTS_FILE):
                with open(SPOTS_FILE, "rb") as f:
                    data = f.read()
            self._send(200, data, "application/json")
        elif self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                while True:
                    self.wfile.write(f"data: {json.dumps(snapshot())}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(0.5)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if self.path != "/api/spots":
            return self._send(404, b"not found", "text/plain")
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            spots = json.loads(body)
            assert isinstance(spots, list)
        except (ValueError, AssertionError):
            return self._send(400, b"bad json", "text/plain")
        os.makedirs(os.path.dirname(SPOTS_FILE), exist_ok=True)
        with open(SPOTS_FILE, "w") as f:
            json.dump(spots, f, indent=2)
        self._send(200, b"ok", "text/plain")


def main():
    url = f"http://localhost:{PORT}"
    open_browser = not os.environ.get("NO_BROWSER")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Already running at {url}")
        if open_browser:
            webbrowser.open(url)
        return
    ensure_sampler()
    threading.Thread(target=wifi_loop, daemon=True).start()
    threading.Thread(target=ping_loop, daemon=True).start()
    print(f"Wi-Fi Spot Finder running at {url}  (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
