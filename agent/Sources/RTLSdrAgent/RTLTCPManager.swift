import Foundation
import Darwin

final class RTLTCPManager {
    struct State {
        var rtlRunning = false
        var devicePresent = false
        var deviceName = ""
        var error: String?
    }

    private var process: Process?
    private var stoppingProcess: Process?
    private var autoRestart = true
    private var generation = 0
    private var startedAt = Date.distantPast
    private let rtlTcpPaths = ["/opt/homebrew/bin/rtl_tcp", "/usr/local/bin/rtl_tcp"]
    private let rtlTestPaths = ["/opt/homebrew/bin/rtl_test", "/usr/local/bin/rtl_test"]

    var onStateChange: (() -> Void)?
    private(set) var state = State()

    private var rtlTcpPath: String? {
        rtlTcpPaths.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private var rtlTestPath: String? {
        rtlTestPaths.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func start() {
        if let old = stoppingProcess, old.isRunning {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.start() }
            return
        }
        guard process == nil else { return }
        autoRestart = true
        guard let path = rtlTcpPath else {
            state.error = "rtl_tcp не найден. Выполните: brew install rtl-sdr"
            onStateChange?()
            return
        }

        generation += 1
        let gen = generation
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["-a", "127.0.0.1", "-p", "1234", "-b", "4"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        p.environment = env

        let errPipe = Pipe()
        p.standardError = errPipe
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            if text.contains("No supported devices found") || text.contains("Failed to open") {
                DispatchQueue.main.async {
                    guard gen == self.generation else { return }
                    self.state.devicePresent = false
                    self.state.deviceName = ""
                    self.state.error = "Устройство не найдено или занято. Подключите RTL-SDR по USB."
                    self.onStateChange?()
                }
            }
        }

        p.terminationHandler = { [weak self] _ in
            errPipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self else { return }
                if self.stoppingProcess === p { self.stoppingProcess = nil }
                guard gen == self.generation else { return }
                self.process = nil
                self.state.rtlRunning = false
                self.onStateChange?()

                let ranLongEnough = Date().timeIntervalSince(self.startedAt) > 5
                if self.autoRestart && self.state.devicePresent && self.state.error == nil && ranLongEnough {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.start() }
                } else if self.autoRestart && self.state.error == nil && !ranLongEnough {
                    self.state.error = "rtl_tcp завершился сразу после запуска — устройство занято или не отвечает"
                    self.onStateChange?()
                }
            }
        }

        do {
            try p.run()
            process = p
            startedAt = Date()
            state.rtlRunning = true
            state.error = nil
            state.devicePresent = true
            state.deviceName = state.deviceName.isEmpty ? "RTL-SDR" : state.deviceName
            onStateChange?()
        } catch {
            process = nil
            state.error = "Не удалось запустить rtl_tcp: \(error.localizedDescription)"
            onStateChange?()
        }
    }

    func stop() {
        autoRestart = false
        guard let p = process, p.isRunning else {
            process = nil
            state.rtlRunning = false
            onStateChange?()
            return
        }
        process = nil
        stoppingProcess = p
        generation += 1
        p.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.stoppingProcess === p, p.isRunning else { return }
            kill(p.processIdentifier, SIGKILL)
        }
        state.rtlRunning = false
        onStateChange?()
    }

    func restart() {
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.start() }
    }

    func probeDevice() {
        if process != nil || stoppingProcess != nil {
            if !state.devicePresent || state.error != nil {
                state.devicePresent = true
                state.error = nil
                onStateChange?()
            }
            return
        }
        guard let testPath = rtlTestPath else { return }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: testPath)
            p.arguments = ["-t"]
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            p.environment = env
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = pipe
            do {
                try p.run()
                p.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""
                DispatchQueue.main.async {
                    self.applyProbeResult(output)
                }
            } catch {
                DispatchQueue.main.async {
                    self.state.error = "Не удалось проверить устройство: \(error.localizedDescription)"
                    self.onStateChange?()
                }
            }
        }
    }

    private func applyProbeResult(_ output: String) {
        if output.contains("No supported devices found") || output.contains("No devices found") {
            state.devicePresent = false
            state.deviceName = ""
            state.error = "Устройство не найдено. Подключите RTL-SDR по USB."
            onStateChange?()
        } else if output.contains("Found") || output.contains("Using device") {
            state.devicePresent = true
            state.deviceName = parseDeviceName(output)
            state.error = nil
            onStateChange?()
            if !state.rtlRunning && autoRestart {
                start()
            }
        } else {
            state.error = "rtl_test не дал ответа. Подключите RTL-SDR по USB."
            onStateChange?()
        }
    }

    private func parseDeviceName(_ output: String) -> String {
        let tuners = ["R820T", "R828D", "E4000", "FC0012", "FC0013", "FC2580"]
        if let tuner = tuners.first(where: { output.contains($0) }) {
            return "RTL-SDR (\(tuner))"
        }
        return "RTL-SDR"
    }
}
