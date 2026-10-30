import AppKit

final class StatusViewController: NSViewController {
    private let manager: RTLTCPManager

    private let titleLabel = NSTextField(labelWithString: "RTL-SDR")
    private let deviceLabel = NSTextField(labelWithString: "")
    private let rtlLabel = NSTextField(labelWithString: "")
    private let errorLabel = NSTextField(labelWithString: "")
    private let connectButton = NSButton(title: "Подключить", target: nil, action: nil)
    private let restartButton = NSButton(title: "Перезапустить", target: nil, action: nil)
    private let webButton = NSButton(title: "Открыть веб-интерфейс", target: nil, action: nil)
    private let quitButton = NSButton(title: "Выход", target: nil, action: nil)

    init(manager: RTLTCPManager) {
        self.manager = manager
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        titleLabel.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        titleLabel.textColor = .labelColor

        deviceLabel.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        rtlLabel.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        errorLabel.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        errorLabel.textColor = .systemOrange
        errorLabel.lineBreakMode = .byWordWrapping
        errorLabel.preferredMaxLayoutWidth = 240

        connectButton.target = self
        connectButton.action = #selector(toggleConnection)
        connectButton.bezelStyle = .rounded

        restartButton.target = self
        restartButton.action = #selector(restart)
        restartButton.bezelStyle = .rounded

        webButton.target = self
        webButton.action = #selector(openWeb)
        webButton.bezelStyle = .rounded

        quitButton.target = self
        quitButton.action = #selector(quit)
        quitButton.bezelStyle = .rounded

        let buttonRow = NSStackView(views: [connectButton, restartButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8

        let stack = NSStackView(views: [
            titleLabel,
            deviceLabel,
            rtlLabel,
            errorLabel,
            buttonRow,
            webButton,
            quitButton,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)

        let container = NSView()
        container.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            container.widthAnchor.constraint(greaterThanOrEqualToConstant: 260),
        ])
        view = container
        refresh()
    }

    func refresh() {
        let s = manager.state
        if s.devicePresent {
            deviceLabel.stringValue = "Устройство: ● \(s.deviceName)"
            deviceLabel.textColor = .systemGreen
        } else {
            deviceLabel.stringValue = "Устройство: ● не найдено"
            deviceLabel.textColor = .systemRed
        }
        if s.rtlRunning {
            rtlLabel.stringValue = "rtl_tcp: ● запущен (127.0.0.1:1234)"
            rtlLabel.textColor = .systemGreen
        } else {
            rtlLabel.stringValue = "rtl_tcp: ● остановлен"
            rtlLabel.textColor = .systemRed
        }
        errorLabel.stringValue = s.error ?? ""
        connectButton.title = s.rtlRunning ? "Отключить" : "Подключить"
        restartButton.isEnabled = s.rtlRunning
    }

    @objc private func toggleConnection() {
        if manager.state.rtlRunning {
            manager.stop()
        } else {
            manager.start()
        }
    }

    @objc private func restart() {
        manager.restart()
    }

    @objc private func openWeb() {
        if let url = URL(string: "http://localhost:8080") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
