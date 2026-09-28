import Foundation

/// One HTTP round trip. `URLSession` in the app, a fake in tests.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: HTTPTransport {
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// Why a registration failed (§7.1 status codes, plus the transport).
public enum PushGatewayError: Error, Sendable, Equatable, LocalizedError {
    /// 400 `bad-request`.
    case badRequest
    /// 401 `auth`: bad signature, or the phone's clock is more than 300 s off.
    case auth
    /// 429 `rate`: too many registrations from this IP.
    case rate
    /// 503 `unavailable`: that server is not a push gateway.
    case unavailable
    /// Any other status.
    case http(Int)
    /// 200 without a usable `cap`.
    case badResponse
    /// The request didn't complete.
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .badRequest: "The push gateway rejected the registration."
        case .auth: "The push gateway couldn't verify this device. Check the clock."
        case .rate: "Too many push registrations. Try again later."
        case .unavailable: "That server doesn't deliver push notifications."
        case .http(let status): "The push gateway answered HTTP \(status)."
        case .badResponse: "Unexpected answer from the push gateway."
        case .transport(let message): "Couldn't reach the push gateway: \(message)"
        }
    }
}

/// §7.1: turns an APNs token into a push capability.
public struct PushGatewayClient: Sendable {
    public let gateway: URL
    private let transport: any HTTPTransport
    private let now: @Sendable () -> Date

    public init(gateway: URL = Push.defaultGateway, transport: any HTTPTransport = URLSession.shared, now: @escaping @Sendable () -> Date = Date.init) {
        self.gateway = gateway
        self.transport = transport
        self.now = now
    }

    /// The `POST /v1/push/register` URL. A gateway with a path prefix keeps it.
    public var registerURL: URL {
        var base = gateway.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + Push.registerPath)!
    }

    /// Registers `token` (lowercase hex) and returns the `cap`. Every call
    /// invalidates the device's older caps (§7.1).
    public func register(token: String, env: PushEnv, identity: DeviceIdentity) async throws(PushGatewayError) -> String {
        let body: PushRegistration
        do {
            body = try PushRegistration.sign(identity: identity, token: token, env: env, ts: Int64(now().timeIntervalSince1970))
        } catch {
            throw .badRequest
        }
        var request = URLRequest(url: registerURL, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body.json.jsonData

        let data: Data, response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            throw .transport(error.localizedDescription)
        }
        switch response.statusCode {
        case 200:
            guard let value = try? JSONValue.parse(data), let cap = value.objectValue?["cap"]?.stringValue,
                  !cap.isEmpty, cap.count <= Push.capMaxLength else { throw .badResponse }
            return cap
        case 400: throw .badRequest
        case 401: throw .auth
        case 429: throw .rate
        case 503: throw .unavailable
        default: throw .http(response.statusCode)
        }
    }
}
