#!/usr/bin/env python3
"""Wi-Fi Spot Finder: local server.

Samples Wi-Fi signal (via the CoreWLAN helper), pings your router and the internet,
logs everything in the background, detects dropouts, runs lag (bufferbloat) tests,
and serves the dashboard pages in web/.

Run:  python3 server.py      then open http://localhost:8765
"""
import collections
import csv
import io
import json
import os
import re
import signal
import statistics
import subprocess
import threading
import time
import webbrowser
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from tools import channels

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
SAMPLER_SRC = os.path.join(HERE, "wifisampler.swift")
SAMPLER = os.path.join(HERE, "wifisampler")
PORT = int(os.environ.get("PORT", "8765"))
INTERNET_HOST = os.environ.get("INTERNET_HOST", "1.1.1.1")

DATA_DIR = os.environ.get("WSF_DATA_DIR", os.path.expanduser("~/Library/Application Support/Wi-Fi Spot Finder"))
SPOTS_FILE = os.environ.get("SPOTS_FILE", os.path.join(DATA_DIR, "spots.json"))
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
LAGTESTS_FILE = os.path.join(DATA_DIR, "lagtests.json")
EVENTS_FILE = os.path.join(DATA_DIR, "events.jsonl")
FLOORPLAN_FILE = os.path.join(DATA_DIR, "floorplan.bin")
FLOORPLAN_TYPE = os.path.join(DATA_DIR, "floorplan.type")
LOG_DIR = os.path.join(DATA_DIR, "logs")
SCAN_FILE = os.path.join(DATA_DIR, "lastscan.json")
LOG_EVERY = 10          # seconds between history samples
KEEP_DAYS = 30          # history retention
MIN_EVENT_SECS = 3      # ignore blips shorter than this

lock = threading.Lock()
wifi = {}
pings = {"router": collections.deque(maxlen=400), "internet": collections.deque(maxlen=400)}
gateway = None
started_at = time.time()
monitor = {"state": "starting", "since": time.time(), "event": None}
children = []  # helper processes to stop on exit
scan_lock = threading.Lock()
lag = {"running": False, "phase": "", "started": None, "result": None, "error": None}


# ---------------------------------------------------------------- helpers
def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def mean(xs):
    return sum(xs) / len(xs) if xs else None


def rnd(x, n=1):
    return None if x is None else round(x, n)


# ---------------------------------------------------------------- sampling
def ensure_sampler():
    if not os.path.exists(SAMPLER_SRC):  # bundled app ships a prebuilt sampler
        return
    if not os.path.exists(SAMPLER) or os.path.getmtime(SAMPLER) < os.path.getmtime(SAMPLER_SRC):
        print("Compiling Wi-Fi sampler (one-time)…")
        subprocess.run(["swiftc", "-O", SAMPLER_SRC, "-o", SAMPLER], check=True)


def wifi_loop():
    while True:
        proc = subprocess.Popen([SAMPLER, "0.5"], stdout=subprocess.PIPE, text=True)
        children.append(proc)
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
    global gateway
    out = subprocess.run(["route", "-n", "get", "default"], capture_output=True, text=True).stdout
    m = re.search(r"gateway:\s*(\S+)", out)
    gateway = m.group(1) if m else None
    return gateway


def ping_loop(name, host_fn):
    q = pings[name]
    while True:
        host = host_fn()
        if not host:
            with lock:
                q.append((time.time(), None))
            time.sleep(1)
            continue
        proc = subprocess.Popen(["ping", "-i", "0.5", host],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        children.append(proc)
        started = time.time()
        for line in proc.stdout:
            now = time.time()
            m = re.search(r"time=([\d.]+) ms", line)
            if m:
                with lock:
                    q.append((now, float(m.group(1))))
            elif "timeout" in line or "unreachable" in line.lower() or "No route" in line or "sendto" in line:
                with lock:
                    q.append((now, None))
            if now - started > 60 and host_fn() != host:  # network changed
                proc.kill()
                break
        proc.wait()
        time.sleep(0.5)


def ping_stats(name, window=10):
    now = time.time()
    with lock:
        items = list(pings[name])
    recent = [p for p in items if now - p[0] < window]
    ok = [ms for _, ms in recent if ms is not None]
    return {
        "last": items[-1][1] if items and now - items[-1][0] < 3 else None,
        "avg": rnd(mean(ok)),
        "jitter": rnd(mean([abs(a - b) for a, b in zip(ok, ok[1:])])),
        "loss": round(100 * (len(recent) - len(ok)) / len(recent)) if recent else None,
    }


# ---------------------------------------------------------------- monitoring / history
def classify():
    """Return ok | wifi | router | internet | unknown for the current moment."""
    now = time.time()
    if now - started_at < 8:
        return "unknown"
    with lock:
        w = dict(wifi)
        r = list(pings["router"])
        i = list(pings["internet"])
    if not w or now - w.get("t", 0) > 5:
        return "unknown"
    if not w.get("on") or not w.get("rssi"):
        return "wifi"

    def alive(items):
        return any(ms is not None and now - t < 4 for t, ms in items)

    if not alive(r):
        return "router"
    if not alive(i):
        return "internet"
    return "ok"


def log_path(day):
    return os.path.join(LOG_DIR, day.strftime("%Y-%m-%d") + ".jsonl")


def append_line(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(obj) + "\n")


def prune_logs():
    cutoff = (datetime.now() - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    for name in os.listdir(LOG_DIR) if os.path.isdir(LOG_DIR) else []:
        if name.endswith(".jsonl") and name[:10] < cutoff:
            os.remove(os.path.join(LOG_DIR, name))


def monitor_loop():
    rssis, worst, last_write, last_prune = [], "ok", time.time(), 0
    severity = {"ok": 0, "unknown": 0, "internet": 1, "router": 2, "wifi": 3}
    while True:
        time.sleep(1)
        now = time.time()
        state = classify()
        with lock:
            w = dict(wifi)
        if w.get("rssi"):
            rssis.append(w["rssi"])
        if severity[state] > severity[worst]:
            worst = state

        # dropout events
        if state != "unknown" and state != monitor["state"]:
            ev = monitor["event"]
            if ev:
                ev["end"] = now
                ev["duration"] = round(now - ev["start"], 1)
                if ev["duration"] >= MIN_EVENT_SECS:
                    append_line(EVENTS_FILE, ev)
                monitor["event"] = None
            if state != "ok":
                monitor["event"] = {"start": now, "kind": state}
            monitor["state"], monitor["since"] = state, now

        # history sample
        if now - last_write >= LOG_EVERY:
            r, i = ping_stats("router", LOG_EVERY), ping_stats("internet", LOG_EVERY)
            append_line(log_path(datetime.now()), {
                "t": round(now), "rssi": rnd(mean(rssis)), "noise": w.get("noise"), "tx": w.get("tx"),
                "r": r["avg"], "rl": r["loss"], "i": i["avg"], "il": i["loss"], "s": worst,
            })
            rssis, worst, last_write = [], "ok", now
        if now - last_prune > 6 * 3600:
            prune_logs()
            last_prune = now


def load_samples(since):
    out, day = [], datetime.fromtimestamp(since).date()
    while day <= datetime.now().date():
        try:
            with open(log_path(datetime.combine(day, datetime.min.time()))) as f:
                for line in f:
                    try:
                        s = json.loads(line)
                    except ValueError:
                        continue
                    if s["t"] >= since:
                        out.append(s)
        except OSError:
            pass
        day += timedelta(days=1)
    return out


def load_events(since):
    out = []
    try:
        with open(EVENTS_FILE) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e["end"] >= since:
                    out.append(e)
    except OSError:
        pass
    ev = monitor["event"]
    if ev and time.time() - ev["start"] >= MIN_EVENT_SECS:
        out.append({**ev, "end": time.time(), "duration": round(time.time() - ev["start"], 1), "ongoing": True})
    return out


def summarize(samples, events):
    rs = [s["rssi"] for s in samples if s.get("rssi")]
    ins = [s["i"] for s in samples if s.get("i") is not None]
    ils = [s["il"] for s in samples if s.get("il") is not None]
    kinds = collections.Counter(e["kind"] for e in events)
    return {
        "samples": len(samples),
        "monitoredSecs": len(samples) * LOG_EVERY,
        "avgRssi": rnd(mean(rs)),
        "weakPct": round(100 * sum(r < -72 for r in rs) / len(rs)) if rs else None,
        "avgInternet": rnd(mean(ins)),
        "internetLoss": rnd(mean(ils)),
        "dropouts": len(events),
        "downtime": round(sum(e["duration"] for e in events)),
        "byKind": dict(kinds),
    }


_today_cache = {"t": 0, "v": None}


def today_summary():
    if time.time() - _today_cache["t"] > 30:
        midnight = datetime.combine(datetime.now().date(), datetime.min.time()).timestamp()
        _today_cache.update(t=time.time(), v=summarize(load_samples(midnight), load_events(midnight)))
    return _today_cache["v"]


def downsample(samples, max_points=720):
    if len(samples) <= max_points:
        return samples
    step = len(samples) / max_points
    out = []
    for k in range(max_points):
        chunk = samples[int(k * step):int((k + 1) * step)] or samples[-1:]
        row = {"t": chunk[len(chunk) // 2]["t"]}
        for key in ("rssi", "r", "i", "il", "rl"):
            vals = [c[key] for c in chunk if c.get(key) is not None]
            row[key] = rnd(mean(vals))
        bad = [c["s"] for c in chunk if c.get("s") not in (None, "ok", "unknown")]
        row["s"] = bad[0] if bad else "ok"
        out.append(row)
    return out


# ---------------------------------------------------------------- snapshot
def snapshot():
    with lock:
        d = dict(wifi)
    r, i = ping_stats("router"), ping_stats("internet")
    d.update(gateway=gateway, ping=r["last"], pingAvg=r["avg"], jitter=r["jitter"], loss=r["loss"],
             inet=i["last"], inetAvg=i["avg"], inetJitter=i["jitter"], inetLoss=i["loss"],
             internetHost=INTERNET_HOST, state=monitor["state"], since=monitor["since"],
             lagRunning=lag["running"])
    return d


# ---------------------------------------------------------------- lag (bufferbloat) test
def grade_for(added_ms):
    if added_ms is None:
        return None
    for limit, g in ((5, "A+"), (30, "A"), (60, "B"), (200, "C"), (400, "D")):
        if added_ms < limit:
            return g
    return "F"


def parse_nq_time(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S.%f").timestamp()
    except (TypeError, ValueError):
        return None


def run_lagtest():
    t0 = time.time()
    lag.update(running=True, phase="idle", started=t0, result=None, error=None)
    try:
        time.sleep(6)  # idle baseline
        lag["phase"] = "load"
        proc = subprocess.run(["networkQuality", "-s", "-c"], capture_output=True, text=True, timeout=180)
        nq = json.loads(proc.stdout)
        lag["phase"] = "analyze"
        time.sleep(1)
        with lock:
            ps = [(t, ms) for t, ms in pings["internet"] if t >= t0]

        def window(a, b):
            seg = [ms for t, ms in ps if a is not None and b is not None and a <= t <= b]
            ok = [x for x in seg if x is not None]
            return (statistics.median(ok) if ok else None,
                    round(100 * (len(seg) - len(ok)) / len(seg)) if seg else None)

        dl = (parse_nq_time(nq.get("dl_phase_start")), parse_nq_time(nq.get("dl_phase_end")))
        ul = (parse_nq_time(nq.get("ul_phase_start")), parse_nq_time(nq.get("ul_phase_end")))
        idle_ms, idle_loss = window(t0, t0 + 6)
        dl_ms, dl_loss = window(*dl)
        ul_ms, ul_loss = window(*ul)
        base = nq.get("base_rtt")

        def med(key):
            v = nq.get(key) or []
            return statistics.median(v) if v else None

        # Apple's probes on *separate* connections while the line is loaded behave like a video call
        apple_idle = med("il_h2_req_resp") or base
        apple_dl, apple_ul = med("lud_foreign_dl_h2_req_resp"), med("lud_foreign_ul_h2_req_resp")

        def rise(loaded, idle):
            return None if loaded is None or idle is None else max(0.0, loaded - idle)

        dl_ping_add, ul_ping_add = rise(dl_ms, idle_ms), rise(ul_ms, idle_ms)
        dl_apple_add, ul_apple_add = rise(apple_dl, apple_idle), rise(apple_ul, apple_idle)

        def worse(a, b):
            vals = [x for x in (a, b) if x is not None]
            return max(vals) if vals else None

        dl_add, ul_add = worse(dl_ping_add, dl_apple_add), worse(ul_ping_add, ul_apple_add)
        worst = max(x for x in (dl_add, ul_add, 0) if x is not None)
        result = {
            "at": time.time(),
            "grade": grade_for(worst), "gradeDown": grade_for(dl_add), "gradeUp": grade_for(ul_add),
            "down": rnd((nq.get("dl_throughput") or 0) / 1e6), "up": rnd((nq.get("ul_throughput") or 0) / 1e6),
            "idle": rnd(idle_ms), "dlLatency": rnd(dl_ms), "ulLatency": rnd(ul_ms),
            "dlAdded": rnd(dl_add), "ulAdded": rnd(ul_add), "dlLoss": dl_loss, "ulLoss": ul_loss,
            "dlAddedPing": rnd(dl_ping_add), "ulAddedPing": rnd(ul_ping_add),
            "dlAddedApple": rnd(dl_apple_add), "ulAddedApple": rnd(ul_apple_add), "appleIdle": rnd(apple_idle),
            "rpmDown": rnd(nq.get("dl_responsiveness"), 0), "rpmUp": rnd(nq.get("ul_responsiveness"), 0),
            "server": nq.get("test_endpoint"), "target": INTERNET_HOST,
        }
        history = read_json(LAGTESTS_FILE, [])
        history.append(result)
        write_json(LAGTESTS_FILE, history[-50:])
        lag["result"] = {**result,
                         "phases": {k: [None if a is None else round(a - t0, 1), None if b is None else round(b - t0, 1)]
                                    for k, (a, b) in (("idle", (t0, t0 + 6)), ("download", dl), ("upload", ul))},
                         "pings": [[round(t - t0, 1), ms] for t, ms in ps]}
    except subprocess.TimeoutExpired:
        lag["error"] = "The test took too long. Check your connection and try again."
    except (ValueError, OSError) as e:
        lag["error"] = f"Couldn't run Apple's networkQuality tool ({e})."
    finally:
        lag.update(running=False, phase="done")


def lag_state():
    t0 = lag["started"]
    st = {k: lag[k] for k in ("running", "phase", "error", "result")}
    if lag["running"] and t0:
        with lock:
            st["pings"] = [[round(t - t0, 1), ms] for t, ms in pings["internet"] if t >= t0]
        st["elapsed"] = round(time.time() - t0, 1)
    st["history"] = read_json(LAGTESTS_FILE, [])
    st["gateway"] = gateway
    return st


# ---------------------------------------------------------------- CSV export
def csv_response(rows, header):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue().encode()


def fmt_ts(t):
    return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S")


KIND_LABEL = {"wifi": "Wi-Fi disconnected", "router": "Router unreachable",
              "internet": "Internet down (router OK; likely ISP)"}


# ---------------------------------------------------------------- HTTP
STATIC_RE = re.compile(r"^/([a-z0-9_-]+\.(html|css|js|png|svg))$")
CTYPES = {"html": "text/html; charset=utf-8", "css": "text/css", "js": "text/javascript",
          "png": "image/png", "svg": "image/svg+xml"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _body(self, limit=25 * 1024 * 1024):
        n = int(self.headers.get("Content-Length", 0))
        if n > limit:
            raise ValueError("too large")
        return self.rfile.read(n)

    def do_GET(self):
        url = urlparse(self.path)
        path, qs = url.path, parse_qs(url.query)
        try:
            hours = min(max(float(qs.get("hours", ["24"])[0]), 1), 24 * 30)
        except ValueError:
            hours = 24
        since = time.time() - hours * 3600

        if path == "/":
            path = "/index.html"
        m = STATIC_RE.match(path)
        if m:
            fp = os.path.join(WEB_DIR, m.group(1))
            if os.path.isfile(fp):
                with open(fp, "rb") as f:
                    return self._send(200, f.read(), CTYPES[m.group(2)])
            return self._send(404, b"not found", "text/plain")

        if path == "/events":
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
                return
        if path == "/api/now":
            return self._json({**snapshot(), "today": today_summary()})
        if path == "/api/spots":
            return self._json(read_json(SPOTS_FILE, []))
        if path == "/api/settings":
            return self._json(read_json(SETTINGS_FILE, {}))
        if path == "/api/floorplan":
            if not os.path.exists(FLOORPLAN_FILE):
                return self._send(404, b"none", "text/plain")
            with open(FLOORPLAN_FILE, "rb") as f:
                data = f.read()
            ctype = open(FLOORPLAN_TYPE).read().strip() if os.path.exists(FLOORPLAN_TYPE) else "image/png"
            return self._send(200, data, ctype)
        if path == "/api/history":
            samples, events = load_samples(since), load_events(since)
            return self._json({"from": since, "to": time.time(), "summary": summarize(samples, events),
                               "samples": downsample(samples), "events": events})
        if path == "/api/lagtest":
            return self._json(lag_state())
        if path == "/api/scan":
            return self._json(read_json(SCAN_FILE, None))
        if path == "/api/export/outages.csv":
            rows = [[fmt_ts(e["start"]), fmt_ts(e["end"]), round(e["duration"]), KIND_LABEL.get(e["kind"], e["kind"]),
                     "yes" if e.get("ongoing") else ""] for e in load_events(since)]
            body = csv_response(rows, ["start", "end", "duration_seconds", "what_happened", "ongoing"])
            return self._send(200, body, "text/csv", {"Content-Disposition": 'attachment; filename="wifi-outages.csv"'})
        if path == "/api/export/samples.csv":
            rows = [[fmt_ts(s["t"]), s.get("rssi"), s.get("noise"), s.get("tx"), s.get("r"), s.get("rl"),
                     s.get("i"), s.get("il"), s.get("s")] for s in load_samples(since)]
            body = csv_response(rows, ["time", "signal_dbm", "noise_dbm", "link_mbps", "router_ping_ms",
                                       "router_loss_pct", "internet_ping_ms", "internet_loss_pct", "status"])
            return self._send(200, body, "text/csv", {"Content-Disposition": 'attachment; filename="wifi-history.csv"'})
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path in ("/api/spots", "/api/settings"):
                data = json.loads(self._body(2 * 1024 * 1024))
                expected = list if path == "/api/spots" else dict
                if not isinstance(data, expected):
                    raise ValueError("wrong shape")
                write_json(SPOTS_FILE if path == "/api/spots" else SETTINGS_FILE, data)
                return self._json({"ok": True})
            if path == "/api/floorplan":
                ctype = self.headers.get("Content-Type", "")
                if not ctype.startswith("image/"):
                    raise ValueError("not an image")
                body = self._body()
                os.makedirs(DATA_DIR, exist_ok=True)
                with open(FLOORPLAN_FILE, "wb") as f:
                    f.write(body)
                with open(FLOORPLAN_TYPE, "w") as f:
                    f.write(ctype)
                return self._json({"ok": True})
            if path == "/api/scan":
                with scan_lock:
                    result = channels.scan(SAMPLER)
                write_json(SCAN_FILE, result)
                return self._json(result)
            if path == "/api/lagtest":
                if not lag["running"]:
                    lag.update(running=True, phase="idle", started=time.time(), result=None, error=None)
                    threading.Thread(target=run_lagtest, daemon=True).start()
                return self._json({"ok": True})
        except ValueError as e:
            return self._send(400, str(e).encode(), "text/plain")
        except (OSError, subprocess.SubprocessError) as e:
            return self._send(500, str(e).encode(), "text/plain")
        self._send(404, b"not found", "text/plain")

    def do_DELETE(self):
        if urlparse(self.path).path == "/api/floorplan":
            for p in (FLOORPLAN_FILE, FLOORPLAN_TYPE):
                if os.path.exists(p):
                    os.remove(p)
            return self._json({"ok": True})
        self._send(404, b"not found", "text/plain")


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
    os.makedirs(LOG_DIR, exist_ok=True)
    ensure_sampler()
    threading.Thread(target=wifi_loop, daemon=True).start()
    threading.Thread(target=ping_loop, args=("router", find_gateway), daemon=True).start()
    threading.Thread(target=ping_loop, args=("internet", lambda: INTERNET_HOST), daemon=True).start()
    threading.Thread(target=monitor_loop, daemon=True).start()
    print(f"Wi-Fi Spot Finder running at {url}  (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)  # the Mac app stops us with SIGTERM
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        # close an ongoing dropout so it isn't lost
        ev = monitor["event"]
        if ev and time.time() - ev["start"] >= MIN_EVENT_SECS:
            append_line(EVENTS_FILE, {**ev, "end": time.time(), "duration": round(time.time() - ev["start"], 1)})
        for p in children:
            if p.poll() is None:
                p.terminate()
        print("\nStopped.")


if __name__ == "__main__":
    main()
