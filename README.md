<p align="center"><img src="assets/logo.png" width="128" alt="Wi-Fi Spot Finder logo"></p>

<h1 align="center">Wi-Fi Spot Finder</h1>

<p align="center">Walk around with your Mac and find the spot with the best Wi-Fi, live.</p>

---

A small macOS tool that shows your Wi-Fi signal strength in real time, so you can find the best place to sit or the best place for a mesh node or extender.

## Features

- **Live signal gauge**: RSSI in dBm, updated twice a second, with a quality label (Excellent → Very weak)
- **Getting better / worse indicator** as you move around
- **Geiger-counter sound mode**: beeps get faster and higher as the signal improves, so you don't have to watch the screen
- **Connection details**: signal-to-noise ratio, link rate, router ping, jitter and packet loss
- **60-second history chart** of signal and ping
- **Spot comparison**: record 10 s at each location, and spots are scored (0–100) and ranked

## Requirements

- macOS 13+
- Xcode Command Line Tools (`xcode-select --install`) for `swiftc`
- Python 3 (`brew install python`)

## Usage

**As a Mac app** (own window, Dock icon):

```sh
./build-app.sh
```

This builds `Wi-Fi Spot Finder.app` and installs it into `/Applications`. Quitting the app stops everything.

**From the terminal** (opens in your browser):

```sh
python3 server.py
```

Then open <http://localhost:8765>. You can also double-click `Start Wi-Fi Spot Finder.command`.

If macOS asks to let the app find devices on your local network, click **Allow**. It needs this to ping your router.

## How it works

| File | Role |
|---|---|
| `wifisampler.swift` | Reads RSSI, noise, link rate and channel from CoreWLAN; prints one JSON line per sample |
| `server.py` | Runs the sampler and a `ping` to your router, and streams both to the page via Server-Sent Events |
| `index.html` | The dashboard (vanilla JS, no dependencies) |
| `app/main.swift` | Native wrapper: starts the server and shows the dashboard in a WebKit window |
| `app/icon.swift` | Draws the app icon |
| `build-app.sh` | Compiles everything into a `.app` bundle |

Browsers can't read Wi-Fi signal strength, which is why a local helper is needed. The server only listens on `127.0.0.1`, and nothing is sent anywhere. Recorded spots are saved to `~/Library/Application Support/Wi-Fi Spot Finder/spots.json`.

## Reading the numbers

| Signal | Quality |
|---|---|
| −55 dBm or better | Excellent |
| −65 dBm | Good |
| −72 dBm | Fair |
| −80 dBm or worse | Unreliable |

A signal-to-noise ratio of 25 dB or more is good. A router ping should normally be a steady 1–5 ms.
