# DevTool for iOS

The SwiftUI iPhone and iPad client for DevTool (milestone 1: pairing and a read-only inbox). The wire protocol is specified in [`protocol/SPEC.md`](../protocol/SPEC.md).

```
ios/
  project.yml      xcodegen spec (the .xcodeproj is generated and gitignored)
  DevTool/         app target: App/ (model, persistence, launch options), Views/, Pairing/
  DevToolKit/      Swift package: protocol models, connection seam, Keychain helper
```

`DevToolKit` holds everything that can be tested without a simulator:

- `Models/`: `PairingInvite` (parses and validates `devtool://pair?d=…`), `Inbox` and its parts, `Base64URL` (strict), `DeviceId`
- `Crypto/`: CryptoKit-only primitives (X25519, Ed25519, SHA-256, HKDF, HMAC, AES-256-GCM with the Noise nonce, big-endian counter), `Noise_IK_25519_AESGCM_SHA256` (`CipherState`, `SymmetricState`, `HandshakeState` initiator and responder, `NoiseTransport`), and `DeviceIdentity` (keys generated on first launch, raw private keys in the Keychain)
- `Protocol/`: relay messages (§3), frame envelope (§4.1), handshake payloads and app messages (§4.3–4.4) with the same tolerant parsing as `protocol/ts`, version negotiation, pairing-secret derivations. `JSONValue` serializes like `JSON.stringify`, so encoded messages match the TS bytes.
- `Relay/`: `RelayClient` (one `URLSessionWebSocketTask` per relay: challenge → hello, watch, ping every 25 s, reconnect with 1 s → 30 s backoff), `RelayHub` (one client per relay URL), `RelayDesktopConnection` (Noise handshake as initiator, `inbox.get`, inbox and pairing events) and `RelayDesktopConnectionFactory`
- `Connection/`: the `DesktopConnection` / `DesktopConnectionFactory` protocols the app depends on, plus `MockDesktopConnection`
- `Storage/KeychainStore`: raw key bytes by label (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`)

### One socket per relay

The relay allows one connection per device ID and closes the older one (4409) when another arrives (§3.5). A phone paired with several desktops on one relay therefore shares a single `RelayClient`: each `RelayDesktopConnection` subscribes with its desktop ID, and the client routes `frame`/`peer`/`error` by `from`/`id`/`to`. A `hello` can carry only one `pair` token, so when a pairing starts while the socket is already up, the client reconnects with the token and the other desktops simply handshake again (they do on every reconnect anyway).

## Requirements

- Xcode 16 or newer (built with Xcode 27 / Swift 6.4), iOS 17+ deployment target
- [xcodegen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`

## Generate and build

```bash
cd ios
xcodegen generate                     # re-run after adding/removing files or editing project.yml
open DevTool.xcodeproj                # or build from the command line:
xcodebuild -project DevTool.xcodeproj -scheme DevTool \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  build CODE_SIGNING_ALLOWED=NO
```

Signing is automatic with no team set. That's enough for the simulator. To run on a device, pick your team in Xcode (Signing & Capabilities) and don't commit it. The bundle ID `sk.awantech.devtool` is a placeholder set in `project.yml`.

## Run on the simulator

```bash
cd ios
xcodebuild -project DevTool.xcodeproj -scheme DevTool \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build/DerivedData \
  build CODE_SIGNING_ALLOWED=NO
SIM=$(xcrun simctl list devices available | grep -m1 'iPhone 17 (' | grep -oE '[0-9A-F-]{36}')
xcrun simctl boot "$SIM"; open -a Simulator
xcrun simctl install "$SIM" build/DerivedData/Build/Products/Debug-iphonesimulator/DevTool.app
xcrun simctl launch "$SIM" sk.awantech.devtool -mockDesktop
```

The simulator has no camera. Pair by pasting a link into **Paste pairing link**, or open one directly with `xcrun simctl openurl booted 'devtool://pair?d=…'`. The app registers the `devtool` URL scheme, so scanning the QR code with the system Camera app on a device opens it too.

## Mock mode

`-mockDesktop` (launch argument) or `DEVTOOL_MOCK_DESKTOP=1` (environment; with `simctl launch`, use `SIMCTL_CHILD_DEVTOOL_MOCK_DESKTOP=1`) preloads two paired desktops and keeps all state in memory:

- **join3r-mbp** is online. It serves a canned inbox and flips one agent tab's status every 4 seconds.
- **studio-mini** is offline. It shows a cached inbox, dimmed, under the "offline · last seen" banner.

The Xcode scheme passes `-mockDesktop` by default. Untick it under Product → Scheme → Edit Scheme → Arguments to use real, persisted pairings through the relay in the pairing link. In mock mode pairing runs against the mock and auto-accepts after 2 seconds.

## Against a local relay

```bash
cd relay && npm install && npm start                          # ws://localhost:8787
node protocol/tools/fake-desktop.ts ws://localhost:8787       # prints a devtool://pair link
xcrun simctl launch "$SIM" sk.awantech.devtool                # without -mockDesktop
xcrun simctl openurl "$SIM" 'devtool://pair?d=…'
```

Debug builds also accept `-pairLink '<devtool://pair?d=…>' [-autoConfirmPairing]` to open (and confirm) a pairing link at launch, which skips the system "Open in DevTool?" prompt in scripted runs, and `-demoRoute <route>` for screenshots: `task` (task detail), `pair` (pairing sheet), `pairConfirm`, `pairWait`, `settings`, `sidebar`.

## Tests

```bash
cd ios/DevToolKit
swift test
```

These run on macOS with no simulator. They load `protocol/vectors/*.json` and `protocol/vectors/official/*.json` straight from the repo (official cacophony/snow/noise-c and generated Noise IK vectors byte for byte, derivations, relay auth, pairing URIs, app-message samples), and drive `RelayDesktopConnection` against an in-process fake relay and desktop (`FakeRelay.swift`).

CryptoKit's Ed25519 signatures are randomized, not deterministic RFC 8032, so `relay-auth.json` signatures are checked by verification both ways instead of byte equality.

`LiveRelayIntegrationTests` runs the real pair → accept → inbox → resume flow against a live relay and `fake-desktop.ts`. It is skipped unless `DEVTOOL_RELAY_URL` is set:

```bash
DEVTOOL_RELAY_URL=ws://localhost:8787 DEVTOOL_PAIRING_URI='devtool://pair?d=…' swift test --filter LiveRelayIntegrationTests
```

## Storage

- Paired desktops go in `Application Support/DevTool/desktops.json`, and each desktop's last inbox goes in `Application Support/DevTool/inbox/<desktopId>.json`. Both use file protection until first unlock.
- Private keys go in the Keychain under service `sk.awantech.devtool.keys` through `KeychainStore`, as `device.x25519` and `device.ed25519` (raw 32 bytes each).
