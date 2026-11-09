<img src="assets/logo.png" width="72" align="right" alt="">

# Wi-Fi Spot Finder

A small macOS app for figuring out where the Wi-Fi in your place is actually good.

It started as a quick way to walk around with the laptop and watch the signal number change, and then kept growing. It's now a handful of small tools in one window:

- **Live** shows the signal in dBm, ping to your router and to 1.1.1.1, and has a beep mode (faster beeps = better signal) so you don't have to stare at the screen while walking around.
- **Heatmap** lets you drop in a floor plan (a phone photo of a sketch is fine), click where you're standing and record for 10 seconds. After a few rooms you get a rough coverage map, your dead zones, and a suggestion for where a mesh node or extender would help.
- **Channels** scans the networks around you, shows how crowded your router's channel is, and suggests a quieter one.
- **Lag test** checks how much your latency goes up when the connection is busy (bufferbloat). If it's bad, it tells you what QoS limits to try on your router.
- **Speed** runs short speed tests on a schedule (off by default) and compares them with the plan you pay for, including which time of day is slowest. Results that were held back by weak Wi-Fi are flagged and left out, so the numbers are fair to your ISP.
- **DNS** times your current DNS against your router and a few public resolvers.
- **Devices** lists what's on your network, with the maker where it can be worked out, and lets you name things. The app sends a notification when something new joins.
- **History** logs in the background and keeps track of dropouts, split into "Wi-Fi dropped", "router stopped answering" and "internet was down". You can export the outages as a CSV if you need to show your ISP.

There's also a menu bar icon with the current signal and a short summary for the day.

<p>
  <img src="assets/screenshots/live.jpg" width="49%" alt="Live view">
  <img src="assets/screenshots/heatmap.jpg" width="49%" alt="Heatmap">
</p>
<img src="assets/screenshots/lag.jpg" width="49%" alt="Lag test">

## Running it

You need macOS 13 or newer, the Xcode command line tools (`xcode-select --install`) and Python 3.

```sh
git clone https://github.com/Ilakiancs/wifi-spot-finder.git
cd wifi-spot-finder
./build-app.sh
```

That builds the app and copies it into `/Applications` (`./build-app.sh --no-install` just builds it into `build/`). If you don't want the app, `python3 server.py` works too and opens the same pages in your browser at http://localhost:8765.

A few permission prompts you might see:

- **Local network**: needed to ping your router and find devices. Say yes.
- **Notifications**: only used for the "new device joined" alert.
- **Location**: optional. macOS only shows the *names* of nearby networks to apps with Location access, so the Channels tab asks for it if you press "Show network names". Channel numbers and signal work without it, and your location is never read.

## How it works

Browsers can't read Wi-Fi signal strength, so there's a tiny Swift program (`wifisampler.swift`) that asks CoreWLAN for it twice a second, and can also scan for nearby networks. `server.py` runs that, pings the router and 1.1.1.1, writes a log line every 10 seconds, and serves the pages in `web/`. The bigger tools live in `tools/` (channel scoring, speed checks, device list, DNS test). The Mac app (`app/main.swift`) is mostly a wrapper: it starts the server, shows the pages in a window and runs the menu bar icon.

Your data stays on your machine, in `~/Library/Application Support/Wi-Fi Spot Finder/`, and logs are kept for 30 days. The only things that go out over the internet are the pings, Apple's `networkQuality` speed tests, the DNS test lookups, and a one-time download of the IEEE's public list of device makers (about 4 MB).

Some notes on the numbers:

- Signal: around -55 dBm or better is great, -65 is fine, -72 is getting iffy, and below -80 things get unreliable.
- Lag grades use the usual bufferbloat scale based on how much delay gets added under load: A+ under 5 ms, A under 30, B under 60, C under 200, D under 400, F above that.
- The lag test runs Apple's `networkQuality` and grades on the worse of two numbers: my own ping to 1.1.1.1, and Apple's latency probes on separate connections during the test. Ping alone often looks fine on networks where video calls clearly aren't, so both are shown.
- A dropout only counts if it lasts at least 3 seconds.
- Channel crowding adds up every network that overlaps a channel, with strong nearby ones counting more than faint ones. Extra network names coming from your own router (a guest network, say) aren't counted against you.
- Each scheduled speed check uses roughly 100 MB. The Speed tab shows an estimate per day before you turn the schedule on.

## Limitations

- macOS only.
- macOS refreshes the signal reading about once a second, so pause for a moment at each spot.
- The heatmap is interpolated between the points you record, so more points means a better map. It fades out where you haven't measured.
- History, speed checks and new-device alerts only happen while the app is running. Turn on "Launch at Login" from the menu bar icon if you want it running all the time.
- Phones and newer laptops use private hardware addresses, so their maker shows as unknown, and some rotate the address now and then and show up as a new device.
- Without Location permission, the channel scanner can't tell your own router's extra networks from a neighbour's for sure, so it guesses from the signal strength.

## License

MIT
