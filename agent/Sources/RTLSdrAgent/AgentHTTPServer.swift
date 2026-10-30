import Foundation
import Network

/// Мини-HTTP-сервер агента: позволяет бэкенду в Docker попросить
/// перезапустить rtl_tcp (лечит «зомби»-соединение). Доступ по токену.
final class AgentHTTPServer {
    private let manager: RTLTCPManager
    private let token: String
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "rtlsdr.agent.http")

    init(manager: RTLTCPManager, token: String) {
        self.manager = manager
        self.token = token
    }

    func start(port: UInt16 = 5055) {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return }
        do {
            let listener = try NWListener(using: .tcp, on: nwPort)
            listener.newConnectionHandler = { [weak self] connection in
                self?.handle(connection)
            }
            listener.start(queue: queue)
            self.listener = listener
            NSLog("RTLSdrAgent: http on :\(port)")
        } catch {
            NSLog("RTLSdrAgent: http failed: \(error)")
        }
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self else {
                connection.cancel()
                return
            }
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let firstLine = text.split(separator: "\r\n").first.map(String.init) ?? ""
            let parts = firstLine.split(separator: " ").map(String.init)
            let method = parts.count > 0 ? parts[0] : ""
            let path = parts.count > 1 ? parts[1] : ""

            var status = "404 Not Found"
            var body = "{\"error\":\"not found\"}"

            if path.hasPrefix("/health") {
                status = "200 OK"
                body = "{\"ok\":true,\"device\":\(self.manager.state.devicePresent),\"rtl\":\(self.manager.state.rtlRunning)}"
            } else if path.hasPrefix("/rtl/restart") {
                let tokenOK = path.contains("token=\(self.token)") || text.contains("x-agent-token: \(self.token)")
                if method == "POST" && tokenOK {
                    DispatchQueue.main.async { self.manager.restart() }
                    status = "200 OK"
                    body = "{\"ok\":true}"
                } else {
                    status = "403 Forbidden"
                    body = "{\"error\":\"forbidden\"}"
                }
            }

            let response = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }
}

enum AgentConfig {
    static let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".rtl-sdr")
    static let tokenURL = dir.appendingPathComponent("agent-token")

    static func token() -> String {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let existing = try? String(contentsOf: tokenURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !existing.isEmpty {
            return existing
        }
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        try? token.write(to: tokenURL, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
        return token
    }
}
