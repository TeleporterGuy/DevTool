import Foundation

/// One open WebSocket carrying relay JSON text frames. Abstracted so tests
/// can drive `RelayClient` with an in-process fake relay.
public protocol WebSocketTransport: AnyObject, Sendable {
    func send(_ text: String) async throws
    /// The next text frame. Throws `WebSocketClosed` once the socket is gone.
    func receive() async throws -> String
    func close(code: Int)
}

/// Opens sockets.
public protocol WebSocketConnector: Sendable {
    func open(_ url: URL) -> any WebSocketTransport
}

public struct WebSocketClosed: Error, Sendable, Equatable {
    /// The close code the peer sent, if any (e.g. 4401 auth, 4409 replaced).
    public var code: Int?
    public var reason: String

    public init(code: Int?, reason: String) {
        self.code = code
        self.reason = reason
    }
}

/// `URLSessionWebSocketTask`-backed sockets.
public struct URLSessionWebSocketConnector: WebSocketConnector {
    public init() {}

    public func open(_ url: URL) -> any WebSocketTransport {
        URLSessionWebSocket(url: url)
    }
}

final class URLSessionWebSocket: WebSocketTransport, @unchecked Sendable {
    // URLSessionWebSocketTask is thread-safe; the session is only used to make it.
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(url: URL) {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
        task = session.webSocketTask(with: url)
        // Relay frames are capped at 256 KiB (§3.5); leave headroom.
        task.maximumMessageSize = 1 << 20
        task.resume()
    }

    deinit {
        session.invalidateAndCancel()
    }

    func send(_ text: String) async throws {
        do {
            try await task.send(.string(text))
        } catch {
            throw closedError(error)
        }
    }

    func receive() async throws -> String {
        while true {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                throw closedError(error)
            }
            switch message {
            case .string(let text):
                return text
            case .data(let data):
                // The relay only sends text frames; tolerate UTF-8 binary ones.
                if let text = String(data: data, encoding: .utf8) { return text }
            @unknown default:
                continue
            }
        }
    }

    func close(code: Int) {
        task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    private func closedError(_ error: any Error) -> WebSocketClosed {
        let code = task.closeCode == .invalid ? nil : task.closeCode.rawValue
        return WebSocketClosed(code: code, reason: error.localizedDescription)
    }
}
