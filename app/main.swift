// Wi-Fi Spot Finder.app
// - starts the bundled server.py (which samples, logs and serves the dashboard)
// - lives in the menu bar with a live signal icon and today's summary
// - shows the dashboard in its own window; closing the window keeps monitoring running
import AppKit
import UniformTypeIdentifiers
import WebKit

let port = 8765
let base = URL(string: "http://localhost:\(port)/")!
let launchAgentLabel = "local.wifispotfinder"
var launchAgentURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents/\(launchAgentLabel).plist")
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate,
                         WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow?
    var web: WKWebView?
    var server: Process?
    var statusItem: NSStatusItem!
    var infoItems: [NSMenuItem] = []
    var loginItem: NSMenuItem!
    var downloads: [ObjectIdentifier: URL] = [:]
    var serverReady = false

    // MARK: lifecycle
    func applicationDidFinishLaunching(_ n: Notification) {
        buildMainMenu()
        buildStatusItem()
        isServerUp { up in
            if !up { self.startServer() }
            self.waitForServer(tries: 0)
        }
        let background = CommandLine.arguments.contains("--background")
        if background { NSApp.setActivationPolicy(.accessory) } else { showPage("index.html") }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in self.poll() }
    }

    func applicationWillTerminate(_ n: Notification) { server?.terminate() }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { showPage("index.html") }
        return true
    }

    // MARK: server
    func isServerUp(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent("api/settings"))
        req.timeoutInterval = 0.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func waitForServer(tries: Int) {
        isServerUp { up in
            if up {
                self.serverReady = true
                if let w = self.web, w.url == nil { w.load(URLRequest(url: self.pendingURL ?? base)) }
                self.poll()
                return
            }
            if tries > 80 { self.showError(); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForServer(tries: tries + 1) }
        }
    }

    func startServer() {
        let res = Bundle.main.resourceURL!
        let python = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
            .first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/bin/python3"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = [res.appendingPathComponent("server.py").path]
        var env = ProcessInfo.processInfo.environment
        env["NO_BROWSER"] = "1"
        env["PORT"] = String(port)
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
        p.environment = env
        do { try p.run(); server = p } catch { showError() }
    }

    func showError() {
        let a = NSAlert()
        a.messageText = "Couldn't start the Wi-Fi monitor"
        a.informativeText = "Wi-Fi Spot Finder needs Python 3. Install it with Homebrew (brew install python) and reopen the app."
        a.runModal()
        NSApp.terminate(nil)
    }

    // MARK: window
    var pendingURL: URL?

    func showPage(_ page: String) {
        let url = base.appendingPathComponent(page)
        NSApp.setActivationPolicy(.regular)
        if window == nil {
            let cfg = WKWebViewConfiguration()
            cfg.mediaTypesRequiringUserActionForPlayback = []
            let w = WKWebView(frame: .zero, configuration: cfg)
            w.setValue(false, forKey: "drawsBackground")
            w.navigationDelegate = self
            w.uiDelegate = self
            web = w
            let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 880),
                               styleMask: [.titled, .closable, .miniaturizable, .resizable],
                               backing: .buffered, defer: false)
            win.title = "Wi-Fi Spot Finder"
            win.minSize = NSSize(width: 420, height: 500)
            win.contentView = w
            win.isReleasedWhenClosed = false
            win.delegate = self
            win.center()
            win.setFrameAutosaveName("MainWindow")
            window = win
        }
        if serverReady { web?.load(URLRequest(url: url)) } else { pendingURL = url }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ n: Notification) {
        // keep monitoring in the menu bar; hide the Dock icon
        web?.loadHTMLString("", baseURL: nil)  // drop the live stream while hidden
        window = nil
        web = nil
        DispatchQueue.main.async { NSApp.setActivationPolicy(.accessory) }
    }

    @objc func openLive() { showPage("index.html") }
    @objc func openHeatmap() { showPage("heatmap.html") }
    @objc func openLag() { showPage("lag.html") }
    @objc func openHistory() { showPage("history.html") }
    @objc func reload() { web?.reload() }
    @objc func openDataFolder() {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Wi-Fi Spot Finder")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)
    }

    // MARK: menu bar
    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = symbol("wifi", value: 0, color: .secondaryLabelColor)
        statusItem.button?.imagePosition = .imageLeading
        let m = NSMenu()
        m.autoenablesItems = false
        m.delegate = self
        for _ in 0..<4 {
            let it = NSMenuItem(title: "…", action: nil, keyEquivalent: "")
            it.isEnabled = true
            infoItems.append(it); m.addItem(it)
        }
        m.addItem(.separator())
        for (title, sel, key) in [("Live Spot Finder", #selector(openLive), "1"), ("Heatmap", #selector(openHeatmap), "2"),
                                  ("Lag Test", #selector(openLag), "3"), ("History & Dropouts", #selector(openHistory), "4")] {
            let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            it.target = self; m.addItem(it)
        }
        m.addItem(.separator())
        loginItem = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
        loginItem.target = self
        loginItem.state = FileManager.default.fileExists(atPath: launchAgentURL.path) ? .on : .off
        m.addItem(loginItem)
        let data = NSMenuItem(title: "Open Data Folder", action: #selector(openDataFolder), keyEquivalent: "")
        data.target = self; m.addItem(data)
        m.addItem(.separator())
        m.addItem(NSMenuItem(title: "Quit Wi-Fi Spot Finder", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = m
    }

    func menuWillOpen(_ menu: NSMenu) { poll() }

    func symbol(_ name: String, value: Double?, color: NSColor) -> NSImage? {
        let img = value != nil
            ? NSImage(systemSymbolName: name, variableValue: value!, accessibilityDescription: "Wi-Fi")
            : NSImage(systemSymbolName: name, accessibilityDescription: "Wi-Fi")
        let cfg = NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
            .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
        let out = img?.withSymbolConfiguration(cfg)
        out?.isTemplate = false
        return out
    }

    func color(for rssi: Int) -> NSColor {
        switch rssi {
        case (-55)...: return .systemGreen
        case (-65)...: return NSColor(srgbRed: 0.45, green: 0.75, blue: 0.25, alpha: 1)
        case (-72)...: return .systemYellow
        case (-80)...: return .systemOrange
        default: return .systemRed
        }
    }

    func label(for rssi: Int) -> String {
        switch rssi {
        case (-55)...: return "Excellent"
        case (-65)...: return "Good"
        case (-72)...: return "Fair"
        case (-80)...: return "Weak"
        default: return "Very weak"
        }
    }

    func poll() {
        URLSession.shared.dataTask(with: base.appendingPathComponent("api/now")) { data, _, _ in
            let d = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { self.updateStatus(d) }
        }.resume()
    }

    func updateStatus(_ d: [String: Any]?) {
        guard let d = d else {
            statusItem.button?.image = symbol("wifi", value: 0, color: .secondaryLabelColor)
            statusItem.button?.title = ""
            infoItems[0].title = serverReady ? "Monitor not responding" : "Starting…"
            for it in infoItems.dropFirst() { it.title = ""; it.isHidden = true }
            return
        }
        for it in infoItems { it.isHidden = false }
        let rssi = d["rssi"] as? Int ?? 0
        let on = d["on"] as? Bool ?? false
        let state = d["state"] as? String ?? "ok"
        let num = { (k: String) -> String in (d[k] as? Double).map { String(format: "%.0f ms", $0) } ?? "--" }

        if !on || rssi == 0 {
            statusItem.button?.image = symbol("wifi.slash", value: nil, color: .systemRed)
            statusItem.button?.title = ""
            infoItems[0].title = on ? "Wi-Fi not connected" : "Wi-Fi is off"
        } else {
            let problem = ["router": "Router not responding", "internet": "Internet down (ISP side)"][state]
            statusItem.button?.image = problem != nil
                ? symbol("wifi.exclamationmark", value: nil, color: .systemRed)
                : symbol("wifi", value: min(1, max(0.05, Double(rssi + 90) / 35)), color: color(for: rssi))
            statusItem.button?.title = " \(rssi)".replacingOccurrences(of: "-", with: "−")
            statusItem.button?.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            infoItems[0].title = problem.map { "⚠️ \($0)" } ?? "Signal \(rssi) dBm · \(label(for: rssi))".replacingOccurrences(of: "-", with: "−")
        }
        infoItems[1].title = "Router ping \(num("pingAvg")) · Internet \(num("inetAvg"))"
        if let t = d["today"] as? [String: Any] {
            let avg = (t["avgRssi"] as? Double).map { String(format: "%.0f dBm", $0).replacingOccurrences(of: "-", with: "−") } ?? "--"
            let drops = t["dropouts"] as? Int ?? 0
            let down = t["downtime"] as? Int ?? 0
            infoItems[2].title = "Today: avg \(avg) · weak \((t["weakPct"] as? Int).map { "\($0)%" } ?? "--") of the time"
            infoItems[3].title = drops == 0 ? "Today: no dropouts"
                : "Today: \(drops) dropout\(drops == 1 ? "" : "s") · \(down / 60)m \(down % 60)s down"
        }
    }

    // MARK: launch at login (LaunchAgent, starts quietly in the menu bar)
    @objc func toggleLogin() {
        let fm = FileManager.default
        if fm.fileExists(atPath: launchAgentURL.path) {
            try? fm.removeItem(at: launchAgentURL)
            loginItem.state = .off
            return
        }
        let plist: [String: Any] = [
            "Label": launchAgentLabel,
            "ProgramArguments": [Bundle.main.executablePath!, "--background"],
            "RunAtLoad": true,
            "ProcessType": "Interactive",
        ]
        do {
            try fm.createDirectory(at: launchAgentURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: launchAgentURL)
            loginItem.state = .on
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    // MARK: web view: downloads (CSV export) and file picker (floor plan upload)
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        // external links (e.g. the router admin page) open in the default browser
        if let url = action.request.url, url.host != "localhost", url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ w: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let cd = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(cd.contains("attachment") || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }  // target=_blank links
        return nil
    }

    func webView(_ w: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ w: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = (suggestedFilename as NSString).deletingPathExtension, ext = (suggestedFilename as NSString).pathExtension
        var url = dir.appendingPathComponent(suggestedFilename), n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent("\(name) \(n).\(ext)"); n += 1
        }
        downloads[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }

    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = p.allowsMultipleSelection
        panel.allowedContentTypes = [.image]
        panel.message = "Choose a floor plan image (photo, sketch or screenshot)"
        if let win = window {
            panel.beginSheetModal(for: win) { completionHandler($0 == .OK ? panel.urls : nil) }
        } else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }

    // MARK: main menu
    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Wi-Fi Spot Finder", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Wi-Fi Spot Finder", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Wi-Fi Spot Finder", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        for (title, sel, key) in [("Live", #selector(openLive), "1"), ("Heatmap", #selector(openHeatmap), "2"),
                                  ("Lag Test", #selector(openLag), "3"), ("History", #selector(openHistory), "4"),
                                  ("Reload", #selector(reload), "r")] {
            view.addItem(withTitle: title, action: sel, keyEquivalent: key).target = self
        }
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.windowsMenu = win
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
