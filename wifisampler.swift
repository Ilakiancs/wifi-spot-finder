import CoreWLAN
import Foundation

// Prints one JSON line per sample: rssi, noise, txRate, channel, band, width
setvbuf(stdout, nil, _IOLBF, 0)
let interval = Double(CommandLine.arguments.dropFirst().first ?? "0.5") ?? 0.5
guard let iface = CWWiFiClient.shared().interface() else {
    print("{\"error\":\"no wifi interface\"}"); exit(1)
}
while true {
    let ch = iface.wlanChannel()
    let band: String
    switch ch?.channelBand {
    case .band2GHz: band = "2.4"
    case .band5GHz: band = "5"
    case .band6GHz: band = "6"
    default: band = "?"
    }
    let width: Int
    switch ch?.channelWidth {
    case .width20MHz: width = 20
    case .width40MHz: width = 40
    case .width80MHz: width = 80
    case .width160MHz: width = 160
    default: width = 0
    }
    print("{\"rssi\":\(iface.rssiValue()),\"noise\":\(iface.noiseMeasurement()),\"tx\":\(iface.transmitRate()),\"channel\":\(ch?.channelNumber ?? 0),\"band\":\"\(band)\",\"width\":\(width),\"on\":\(iface.powerOn())}")
    Thread.sleep(forTimeInterval: interval)
}
