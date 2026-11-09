// Wi-Fi Spot Finder.app: starts the bundled server.py and shows the dashboard in its own window.
import AppKit
import WebKit

let port = 8765
let pageURL = URL(string: "http://localhost:\(port)/")!

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: .zero, configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")  // no white flash in dark mode

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Wi-Fi Spot Finder"
        window.minSize = NSSize(width: 420, height: 500)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("MainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        isServerUp { up in
            if !up { self.startServer() }
            self.waitAndLoad(tries: 0)
        }
    }

    func isServerUp(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: pageURL.appendingPathComponent("api/spots"))
        req.timeoutInterval = 0.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func waitAndLoad(tries: Int) {
        isServerUp { up in
            if up { self.web.load(URLRequest(url: pageURL)); return }
            if tries > 60 { self.showError(); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitAndLoad(tries: tries + 1) }
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

    func applicationWillTerminate(_ n: Notification) { server?.terminate() }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    @objc func reload() { web.reload() }

    func buildMenu() {
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
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
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
app.setActivationPolicy(.regular)
app.run()
