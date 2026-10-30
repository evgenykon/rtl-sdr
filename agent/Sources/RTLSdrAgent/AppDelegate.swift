import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var probeTimer: Timer?
    private let manager = RTLTCPManager()
    private var httpServer: AgentHTTPServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            let image = NSImage(
                systemSymbolName: "dot.radiowaves.left.and.right",
                accessibilityDescription: "RTL-SDR"
            )
            image?.isTemplate = true
            button.image = image
            button.target = self
            button.action = #selector(togglePopover)
        }

        popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = StatusViewController(manager: manager)

        manager.onStateChange = { [weak self] in self?.refreshStatus() }
        manager.start()

        httpServer = AgentHTTPServer(manager: manager, token: AgentConfig.token())
        httpServer?.start()

        let timer = Timer(timeInterval: 5, target: self, selector: #selector(probeTick), userInfo: nil, repeats: true)
        timer.tolerance = 1
        RunLoop.main.add(timer, forMode: .common)
        probeTimer = timer

        refreshStatus()
    }

    func applicationWillTerminate(_ notification: Notification) {
        probeTimer?.invalidate()
        manager.stop()
    }

    @objc private func probeTick() {
        manager.probeDevice()
    }

    @objc private func togglePopover(_ sender: Any?) {
        if popover.isShown {
            popover.performClose(sender)
        } else if let button = statusItem.button {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }

    private func refreshStatus() {
        let s = manager.state
        statusItem.button?.toolTip = s.devicePresent
            ? "RTL-SDR: \(s.deviceName), rtl_tcp \(s.rtlRunning ? "на порту 1234" : "остановлен")"
            : "RTL-SDR: устройство не найдено"
        (popover.contentViewController as? StatusViewController)?.refresh()
    }
}
