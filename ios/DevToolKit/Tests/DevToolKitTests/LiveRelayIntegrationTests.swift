import Foundation
import Testing
@testable import DevToolKit

/// Full pair → accept → inbox → resume against a live relay and the TS fake
/// desktop. Skipped unless `DEVTOOL_RELAY_URL` is set:
///
///     cd relay && npm start                                   # relay on ws://localhost:8787
///     node protocol/tools/fake-desktop.ts ws://localhost:8787 --state /tmp/fd   # prints a link
///     DEVTOOL_RELAY_URL=ws://localhost:8787 DEVTOOL_PAIRING_URI='devtool://pair?d=…' \
///       swift test --filter LiveRelayIntegrationTests
///
/// The fake desktop auto-accepts and pushes an `inbox` event every 5 s. Each
/// pairing link is single-use: start a fresh one (or wait for the fake desktop
/// to print its next link) before re-running.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["DEVTOOL_RELAY_URL"] != nil, "set DEVTOOL_RELAY_URL and DEVTOOL_PAIRING_URI"))
struct LiveRelayIntegrationTests {
    @Test(.timeLimit(.minutes(1))) func pairAcceptInboxThenResume() async throws {
        let env = ProcessInfo.processInfo.environment
        let uri = try #require(env["DEVTOOL_PAIRING_URI"], "DEVTOOL_PAIRING_URI must hold a fresh link from fake-desktop")
        let invite = try PairingInvite.parse(uri, now: Date())
        if let relay = env["DEVTOOL_RELAY_URL"] {
            #expect(RelayHub.key(invite.relayURL) == RelayHub.key(try #require(URL(string: relay))))
        }

        let factory = RelayDesktopConnectionFactory(
            identity: .generate(), deviceName: "swift-test", appVersion: "ios/0.1.0-test"
        )
        let pairing = factory.pairingConnection(for: invite, deviceName: "swift-test")
        let events = EventRecorder(pairing)
        await pairing.start()

        var i = try await events.waitFor(timeout: .seconds(15)) { $0 == .pairing(.pending) }
        i = try await events.waitFor(after: i, timeout: .seconds(15)) {
            if case .pairing(.accepted) = $0 { return true }
            return false
        }
        i = try await events.waitFor(after: i, timeout: .seconds(10)) { $0 == .state(.online) }
        let first = try await inbox(events, after: i, timeout: .seconds(10))
        #expect(first.inbox.desktop.id == invite.desktopId)
        #expect(!first.inbox.projects.isEmpty)
        // A live `inbox` event (every 5 s from the fake desktop).
        let second = try await inbox(events, after: first.index, timeout: .seconds(12))
        #expect(second.inbox.generatedAt >= first.inbox.generatedAt)
        await pairing.stop()

        // Same phone, fresh socket: `resume` must now be accepted.
        let resume = factory.connection(for: DesktopRecord(invite: invite, keysReference: "test"))
        let resumed = EventRecorder(resume)
        await resume.start()
        let j = try await resumed.waitFor(timeout: .seconds(15)) { $0 == .state(.online) }
        _ = try await inbox(resumed, after: j, timeout: .seconds(10))
        await resume.stop()

        // The link is spent now. A second phone using it gets `ready` and then
        // `error forbidden` from the real relay (§3.7), which must end the pairing.
        let stranger = RelayDesktopConnectionFactory(
            identity: .generate(), deviceName: "swift-test-2", appVersion: "ios/0.1.0-test"
        ).pairingConnection(for: invite, deviceName: "swift-test-2")
        let refused = EventRecorder(stranger)
        await stranger.start()
        _ = try await refused.waitFor(timeout: .seconds(15)) {
            if case .state(.failed) = $0 { return true }
            return false
        }
        #expect(await !refused.events.contains(.pairing(.pending)))
        await stranger.stop()
    }

    private func inbox(_ events: EventRecorder, after index: Int, timeout: Duration) async throws -> (inbox: Inbox, index: Int) {
        let next = try await events.waitFor(after: index, timeout: timeout) {
            if case .inbox = $0 { return true }
            return false
        }
        guard case .inbox(let inbox) = await events.events[next - 1] else { throw ProtocolError("no inbox") }
        return (inbox, next)
    }
}
