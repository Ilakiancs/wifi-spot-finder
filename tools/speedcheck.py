"""Speed checks: scheduled speed tests compared against the plan you pay for."""
import json
import os
import subprocess
import threading
import time
from datetime import datetime

TEST_SECONDS = 16  # cap each run so data use stays predictable (download then upload, ~8 s each)
PERIODS = [("night", 0, 6), ("morning", 6, 12), ("afternoon", 12, 18), ("evening", 18, 24)]


class SpeedChecker:
    def __init__(self, data_dir, wifi_fn, busy_lock):
        self.results_file = os.path.join(data_dir, "speedtests.jsonl")
        self.settings_file = os.path.join(data_dir, "speed_settings.json")
        self.wifi_fn = wifi_fn          # returns the latest Wi-Fi sample (rssi, tx, ...)
        self.busy = busy_lock           # shared with the lag test so heavy tests never overlap
        self.running = False
        self.started = None
        self.error = None

    # ---- settings
    def settings(self):
        try:
            with open(self.settings_file) as f:
                s = json.load(f)
        except (OSError, ValueError):
            s = {}
        return {"planDown": s.get("planDown"), "planUp": s.get("planUp"), "interval": s.get("interval", 0)}

    def save_settings(self, s):
        clean = {
            "planDown": float(s["planDown"]) if s.get("planDown") else None,
            "planUp": float(s["planUp"]) if s.get("planUp") else None,
            "interval": int(s.get("interval") or 0),
        }
        os.makedirs(os.path.dirname(self.settings_file), exist_ok=True)
        with open(self.settings_file, "w") as f:
            json.dump(clean, f)
        return clean

    # ---- running tests
    def start(self, reason="manual"):
        if self.running or not self.busy.acquire(blocking=False):
            return False
        self.running, self.started, self.error = True, time.time(), None
        threading.Thread(target=self._run, args=(reason,), daemon=True).start()
        return True

    def _run(self, reason):
        try:
            w = self.wifi_fn() or {}
            proc = subprocess.run(["networkQuality", "-s", "-c", "-M", str(TEST_SECONDS)],
                                  capture_output=True, text=True, timeout=90)
            nq = json.loads(proc.stdout)
            down = (nq.get("dl_throughput") or 0) / 1e6
            up = (nq.get("ul_throughput") or 0) / 1e6
            tx = w.get("tx") or 0
            row = {
                "t": round(time.time()), "down": round(down, 1), "up": round(up, 1),
                "latency": round(nq["base_rtt"], 1) if nq.get("base_rtt") else None,
                "mb": round(((nq.get("dl_bytes_transferred") or 0) + (nq.get("ul_bytes_transferred") or 0)) / 1e6),
                "rssi": w.get("rssi"), "tx": tx, "reason": reason,
                # real Wi-Fi throughput tops out around half the link rate; near that, Wi-Fi is the bottleneck
                "wifiLimited": bool(tx) and down >= 0.45 * tx,
            }
            os.makedirs(os.path.dirname(self.results_file), exist_ok=True)
            with open(self.results_file, "a") as f:
                f.write(json.dumps(row) + "\n")
        except subprocess.TimeoutExpired:
            self.error = "The speed test timed out."
        except (ValueError, KeyError, OSError) as e:
            self.error = f"Speed test failed ({e})."
        finally:
            self.running = False
            self.busy.release()

    def scheduler_loop(self):
        while True:
            time.sleep(30)
            interval = self.settings()["interval"]
            if not interval:
                continue
            last = self.results(hours=24 * 30)
            last_t = last[-1]["t"] if last else 0
            if time.time() - last_t >= interval * 60:
                self.start(reason="scheduled")

    # ---- reading results
    def results(self, hours=24 * 7):
        since = time.time() - hours * 3600
        out = []
        try:
            with open(self.results_file) as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if r["t"] >= since:
                        out.append(r)
        except OSError:
            pass
        return out

    def summary(self, tests, plan_down, plan_up):
        isp = [t for t in tests if not t.get("wifiLimited")]  # tests that say something about the ISP

        def avg(xs):
            return round(sum(xs) / len(xs), 1) if xs else None

        by_period = {}
        for name, a, b in PERIODS:
            xs = [t["down"] for t in isp if a <= datetime.fromtimestamp(t["t"]).hour < b]
            by_period[name] = {"avgDown": avg(xs), "count": len(xs)}
        avg_down, avg_up = avg([t["down"] for t in isp]), avg([t["up"] for t in isp])
        return {
            "count": len(tests), "ispCount": len(isp), "wifiLimited": len(tests) - len(isp),
            "avgDown": avg_down, "avgUp": avg_up,
            "minDown": min((t["down"] for t in isp), default=None),
            "pctDown": round(100 * avg_down / plan_down) if avg_down and plan_down else None,
            "pctUp": round(100 * avg_up / plan_up) if avg_up and plan_up else None,
            "below50": sum(1 for t in isp if plan_down and t["down"] < 0.5 * plan_down),
            "byPeriod": by_period,
        }

    def state(self, hours):
        s = self.settings()
        tests = self.results(hours)
        return {"settings": s, "running": self.running, "started": self.started, "error": self.error,
                "testSeconds": TEST_SECONDS, "tests": tests, "summary": self.summary(tests, s["planDown"], s["planUp"])}
