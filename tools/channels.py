"""Channel scanner: scans nearby networks and scores how crowded each router channel is."""
import json
import subprocess
import time

DFS = range(52, 145)  # 5 GHz channels that need radar detection; many routers skip them

# primary channels a router can pick, per band and channel width
CANDIDATES = {
    "2.4": {20: [1, 6, 11], 40: [1, 6, 11]},
    "5": {
        20: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165],
        40: [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157],
        80: [36, 52, 100, 116, 132, 149],
        160: [36, 100],
    },
}


def center_freq(ch, band):
    if band == "2.4":
        return 2484 if ch == 14 else 2407 + 5 * ch
    if band == "5":
        return 5000 + 5 * ch
    return 5950 + 5 * ch  # 6 GHz


def span(ch, band, width):
    """Frequency range (MHz) a network on this primary channel and width occupies."""
    f = center_freq(ch, band)
    width = width or 20
    if band == "2.4":
        if width <= 20:
            return f - 11, f + 11  # 2.4 GHz channels are 22 MHz wide and overlap their neighbours
        return (f - 10, f + 30) if ch <= 7 else (f - 30, f + 10)
    if width <= 20:
        return f - 10, f + 10
    base = 5945 if band == "6" else (5170 if ch <= 144 else 5735)
    lo = base + ((f - 10 - base) // width) * width
    return lo, lo + width


def weight(rssi):
    """How much a neighbour hurts: strong, nearby networks count more than faint ones."""
    return max(0.2, min(1.5, (rssi + 95) / 25))


def crowding(lo, hi, others):
    score, count = 0.0, 0
    for n in others:
        olo, ohi = n["span"]
        overlap = min(hi, ohi) - max(lo, olo)
        if overlap > 0:
            count += 1
            score += weight(n["rssi"]) * min(1.0, overlap / min(hi - lo, ohi - olo))
    return round(score, 2), count


def scan(sampler):
    raw = json.loads(subprocess.run([sampler, "scan"], capture_output=True, text=True, timeout=30).stdout)
    cur, nets = raw["current"], raw["networks"]
    for n in nets:
        n["span"] = span(n["channel"], n["band"], n["width"])
        n["self"] = False

    # find our own network in the scan (exact by BSSID if we have it, otherwise closest match)
    same = [n for n in nets if n["band"] == cur["band"] and n["channel"] == cur["channel"] and n["width"] == cur["width"]]
    mine = next((n for n in same if cur.get("bssid") and n.get("bssid") == cur["bssid"]), None)
    if not mine and same:
        best = min(same, key=lambda n: abs(n["rssi"] - cur["rssi"]))
        if abs(best["rssi"] - cur["rssi"]) <= 10:
            mine = best
    if mine:
        mine["self"] = True
        # routers often broadcast extra names (guest network etc.) from the same radio: same channel,
        # near-identical signal, and with BSSIDs available, nearly the same hardware address
        for n in same:
            if n is mine:
                continue
            if mine.get("bssid") and n.get("bssid"):
                n["sibling"] = mine["bssid"][:11] == n["bssid"][:11]
            else:
                n["sibling"] = abs(n["rssi"] - mine["rssi"]) <= 3
    others = [n for n in nets if not n["self"] and not n.get("sibling")]

    bands = {}
    for band, widths in CANDIDATES.items():
        width = cur["width"] if band == cur["band"] and cur["width"] in widths else (20 if band == "2.4" else 80)
        rows = []
        for ch in widths[width]:
            lo, hi = span(ch, band, width)
            s, c = crowding(lo, hi, [n for n in others if n["band"] == band])
            rows.append({"channel": ch, "width": width, "score": s, "count": c, "dfs": band == "5" and ch in DFS})
        bands[band] = rows

    rec = None
    if cur["band"] in bands and cur["channel"]:
        lo, hi = span(cur["channel"], cur["band"], cur["width"])
        cur_score, cur_count = crowding(lo, hi, [n for n in others if n["band"] == cur["band"]])
        rows = bands[cur["band"]]
        # prefer non-DFS channels unless a DFS one is clearly quieter
        best = min(rows, key=lambda r: (r["score"] + (0.75 if r["dfs"] else 0), r["channel"]))
        same_block = span(best["channel"], cur["band"], best["width"]) == (lo, hi)
        rec = {"band": cur["band"], "channel": best["channel"], "width": best["width"], "score": best["score"],
               "count": best["count"], "dfs": best["dfs"], "currentScore": cur_score, "currentCount": cur_count,
               "better": not same_block and best["score"] < cur_score - 0.3}

    for n in nets:
        n["span"] = list(n["span"])
    return {"at": time.time(), "current": cur, "networks": sorted(nets, key=lambda n: -n["rssi"]),
            "bands": bands, "recommendation": rec,
            "namesHidden": all(n.get("ssid") is None for n in nets)}
