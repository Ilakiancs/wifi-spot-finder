"""Device list: finds devices on the local network and notices new ones."""
import csv
import ipaddress
import json
import os
import re
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

OUI_URL = "https://standards-oui.ieee.org/oui/oui.csv"
MAX_HOSTS = 1024  # don't sweep huge subnets


def run(cmd, timeout=5):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (subprocess.TimeoutExpired, OSError):
        return ""


def norm_mac(mac):
    return ":".join(p.zfill(2) for p in mac.lower().split(":"))


def is_private_mac(mac):
    # the "locally administered" bit: phones and laptops use random addresses for privacy
    return bool(int(mac[:2], 16) & 2)


class DeviceTracker:
    def __init__(self, data_dir, gateway_fn):
        self.data_dir = data_dir
        self.store_file = os.path.join(data_dir, "devices.json")
        self.settings_file = os.path.join(data_dir, "devices_settings.json")
        self.oui_file = os.path.join(data_dir, "oui.csv")
        self.gateway_fn = gateway_fn
        self.lock = threading.Lock()
        self.scanning = False
        self.last_scan = None
        self.network = None
        self.alerts = []  # recent "new device" alerts for the menu bar app
        self._oui = None

    # ---- storage
    def load(self):
        try:
            with open(self.store_file) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def save(self, devices):
        os.makedirs(self.data_dir, exist_ok=True)
        tmp = self.store_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(devices, f, indent=1)
        os.replace(tmp, self.store_file)

    def settings(self):
        try:
            with open(self.settings_file) as f:
                return {"auto": True, **json.load(f)}
        except (OSError, ValueError):
            return {"auto": True}

    def save_settings(self, s):
        clean = {"auto": bool(s.get("auto"))}
        os.makedirs(self.data_dir, exist_ok=True)
        with open(self.settings_file, "w") as f:
            json.dump(clean, f)
        return clean

    # ---- vendor lookup (IEEE OUI list, downloaded once in the background)
    _downloading = False

    def _download_oui(self):
        # the IEEE server turns away Python's default client and can be slow, so use curl and resume
        os.makedirs(self.data_dir, exist_ok=True)
        tmp = self.oui_file + ".part"
        try:
            for _ in range(3):
                rc = subprocess.run(["curl", "-fsSL", "-m", "300", "-C", "-", "-o", tmp, OUI_URL],
                                    capture_output=True).returncode
                if rc == 0 and os.path.getsize(tmp) > 100_000:
                    os.replace(tmp, self.oui_file)
                    return
                time.sleep(5)
        finally:
            self._downloading = False

    def oui(self):
        if self._oui is not None:
            return self._oui
        if not os.path.exists(self.oui_file):
            if not self._downloading:
                self._downloading = True
                threading.Thread(target=self._download_oui, daemon=True).start()
            return {}
        table = {}
        try:
            with open(self.oui_file, newline="", encoding="utf-8", errors="replace") as f:
                for row in csv.reader(f):
                    if len(row) >= 3 and len(row[1]) == 6:
                        table[row[1].upper()] = row[2].strip()
        except OSError:
            return {}
        self._oui = table
        return table

    def vendor(self, mac):
        if is_private_mac(mac):
            return None
        return self.oui().get(mac.replace(":", "")[:6].upper())

    # ---- scanning
    def local_network(self):
        out = run(["ifconfig", "en0"])
        ip = re.search(r"inet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-f]+)", out)
        mac = re.search(r"ether ([0-9a-f:]+)", out)
        if not ip:
            return None, None, None
        mask = bin(int(ip.group(2), 16)).count("1")
        net = ipaddress.ip_network(f"{ip.group(1)}/{max(mask, 22)}", strict=False)
        return net, ip.group(1), norm_mac(mac.group(1)) if mac else None

    @staticmethod
    def name_for(ip):
        """Best-effort hostname: the router's DNS first, then multicast DNS (.local names)."""
        try:
            socket.setdefaulttimeout(1.5)
            name = socket.gethostbyaddr(ip)[0]
            if name and name != ip:
                return name.rstrip(".")
        except (OSError, UnicodeError):
            pass
        finally:
            socket.setdefaulttimeout(None)
        out = run(["dig", "+short", "+time=1", "+tries=1", "-p", "5353", "@224.0.0.251", "-x", ip], timeout=3).strip()
        return out.splitlines()[0].rstrip(".") if out and not out.startswith(";") else None

    def scan(self):
        if not self.lock.acquire(blocking=False):
            return False
        self.scanning = True
        try:
            net, my_ip, my_mac = self.local_network()
            if not net:
                return False
            self.network = str(net)
            hosts = [str(h) for h in list(net.hosts())[:MAX_HOSTS]]
            # pinging each address makes the Mac ask "who has this IP?", which fills the ARP table
            # even for devices that ignore pings
            with ThreadPoolExecutor(64) as pool:
                list(pool.map(lambda h: run(["ping", "-c", "1", "-W", "700", h], timeout=3), hosts))
            found = {}
            for m in re.finditer(r"\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+) on en0", run(["arp", "-an"])):
                ip, mac = m.group(1), norm_mac(m.group(2))
                if mac != "ff:ff:ff:ff:ff:ff" and ipaddress.ip_address(ip) in net:
                    found[mac] = ip
            if my_mac and my_ip:
                found[my_mac] = my_ip
            with ThreadPoolExecutor(32) as pool:
                names = dict(zip(found, pool.map(self.name_for, found.values())))

            now = round(time.time())
            stored = self.load()
            baseline = stored is None  # first scan ever: everything is "known", nothing is new
            devices = stored or {}
            gw = self.gateway_fn()
            for mac, ip in found.items():
                d = devices.get(mac)
                if not d:
                    d = devices[mac] = {"mac": mac, "firstSeen": now, "isNew": not baseline, "label": None}
                    if not baseline:
                        self.alerts.append({"id": now * 1000 + len(self.alerts), "t": now, "mac": mac, "ip": ip,
                                            "name": names.get(mac) or self.vendor(mac)})
                        self.alerts = self.alerts[-20:]
                d.update(ip=ip, lastSeen=now, name=names.get(mac) or d.get("name"), vendor=self.vendor(mac) or d.get("vendor"),
                         private=is_private_mac(mac), isRouter=ip == gw, isThisMac=mac == my_mac)
            self.save(devices)
            self.last_scan = now
            return True
        finally:
            self.scanning = False
            self.lock.release()

    def auto_loop(self, every=600):
        time.sleep(20)
        while True:
            if self.settings()["auto"]:
                self.scan()
            time.sleep(every)

    # ---- edits from the page
    def update(self, mac, label=None, known=None):
        devices = self.load() or {}
        d = devices.get(mac)
        if not d:
            raise ValueError("unknown device")
        if label is not None:
            d["label"] = label.strip()[:40] or None
        if known:
            d["isNew"] = False
        self.save(devices)

    def forget(self, mac):
        devices = self.load() or {}
        devices.pop(mac, None)
        self.save(devices)

    def state(self):
        devices = list((self.load() or {}).values())
        last = self.last_scan or max((d.get("lastSeen", 0) for d in devices), default=None)
        for d in devices:
            d["online"] = bool(last) and d.get("lastSeen") == last
            d["vendor"] = d.get("vendor") or self.vendor(d["mac"])
        devices.sort(key=lambda d: (not d["online"], tuple(int(p) for p in d.get("ip", "0.0.0.0").split("."))))
        return {"devices": devices, "lastScan": last, "scanning": self.scanning, "network": self.network,
                "settings": self.settings(), "vendorsLoading": self._downloading}
