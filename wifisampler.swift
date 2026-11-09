import CoreWLAN
import Foundation

// wifisampler [interval]   prints one JSON line per sample: rssi, noise, txRate, channel, band, width
// wifisampler scan         scans nearby networks once and prints a JSON object
setvbuf(stdout, nil, _IOLBF, 0)
guard let iface = CWWiFiClient.shared().interface() else {
    print("{\"error\":\"no wifi interface\"}"); exit(1)
}

func bandName(_ ch: CWChannel?) -> String {
    switch ch?.channelBand {
    case .band2GHz: return "2.4"
    case .band5GHz: return "5"
    case .band6GHz: return "6"
    default: return "?"
    }
}

func widthMHz(_ ch: CWChannel?) -> Int {
    switch ch?.channelWidth {
    case .width20MHz: return 20
    case .width40MHz: return 40
    case .width80MHz: return 80
    case .width160MHz: return 160
    default: return 0
    }
}

func json(_ obj: Any) -> String {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    return String(data: data, encoding: .utf8)!
}

if CommandLine.arguments.dropFirst().first == "scan" {
    // two passes, since a single scan often misses a few networks
    struct Net { var row: [String: Any]; let bssid: String?; let channel: Int; let width: Int; let rssi: Int; var matched = false }
    var merged: [Net] = []
    for pass in 0..<2 {
        guard let nets = try? iface.scanForNetworks(withName: nil) else { continue }
        for n in nets {
            let ch = n.wlanChannel
            let net = Net(row: ["ssid": n.ssid ?? NSNull(), "bssid": n.bssid ?? NSNull(), "rssi": n.rssiValue,
                                "channel": ch?.channelNumber ?? 0, "band": bandName(ch), "width": widthMHz(ch)],
                          bssid: n.bssid, channel: ch?.channelNumber ?? 0, width: widthMHz(ch), rssi: n.rssiValue)
            if pass == 0 { merged.append(net); continue }
            // without Location permission there's no BSSID, so match on channel, width and similar signal
            let idx = merged.firstIndex { m in
                !m.matched && (net.bssid != nil ? m.bssid == net.bssid
                    : m.channel == net.channel && m.width == net.width && abs(m.rssi - net.rssi) <= 6)
            }
            if let i = idx { merged[i].matched = true } else { merged.append(net) }
        }
        if pass == 0 { Thread.sleep(forTimeInterval: 1) }
    }
    let cur = iface.wlanChannel()
    let current: [String: Any] = [
        "ssid": iface.ssid().map { $0 as Any } ?? NSNull(), "bssid": iface.bssid().map { $0 as Any } ?? NSNull(),
        "rssi": iface.rssiValue(), "channel": cur?.channelNumber ?? 0, "band": bandName(cur), "width": widthMHz(cur),
    ]
    print(json(["networks": merged.map { $0.row }, "current": current]))
    exit(0)
}

let interval = Double(CommandLine.arguments.dropFirst().first ?? "0.5") ?? 0.5
while true {
    let ch = iface.wlanChannel()
    print("{\"rssi\":\(iface.rssiValue()),\"noise\":\(iface.noiseMeasurement()),\"tx\":\(iface.transmitRate()),\"channel\":\(ch?.channelNumber ?? 0),\"band\":\"\(bandName(ch))\",\"width\":\(widthMHz(ch)),\"on\":\(iface.powerOn())}")
    Thread.sleep(forTimeInterval: interval)
}
