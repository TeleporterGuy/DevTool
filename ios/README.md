# DevTool for iOS

The SwiftUI iPhone and iPad client for DevTool (milestone 1: pairing and a read-only inbox). The wire protocol is specified in [`protocol/SPEC.md`](../protocol/SPEC.md).

```
ios/
  project.yml            xcodegen spec (the .xcodeproj is generated and gitignored)
  DevTool/               app target: App/ (model, persistence, push, launch options), Views/, Chat/, Pairing/
  DevToolNotifications/  Notification Service Extension: decrypts pushes (SPEC.md §7.5)
  DevToolKit/            Swift package: protocol models, crypto, relay client, push, Keychain helper
```

`DevToolKit` holds everything that can be tested without a simulator:

- `Models/`: `PairingInvite` (parses and validates `devtool://pair?d=…`), `Inbox` and its parts, `Base64URL` (strict), `DeviceId`
- `Crypto/`: CryptoKit-only primitives (X25519, Ed25519, SHA-256, HKDF, HMAC, AES-256-GCM with the Noise nonce, big-endian counter), `Noise_IK_25519_AESGCM_SHA256` (`CipherState`, `SymmetricState`, `HandshakeState` initiator and responder, `NoiseTransport`), and `DeviceIdentity` (keys generated on first launch, raw private keys in the Keychain)
- `Protocol/`: relay messages (§3), frame envelope (§4.1), handshake payloads and app messages (§4.3–4.4) with the same tolerant parsing as `protocol/ts`, version negotiation, pairing-secret derivations. `JSONValue` serializes like `JSON.stringify`, so encoded messages match the TS bytes.
- `Relay/`: `RelayClient` (one `URLSessionWebSocketTask` per relay: challenge → hello, watch, ping every 25 s, reconnect with 1 s → 30 s backoff), `RelayHub` (one client per relay URL), `RelayDesktopConnection` (Noise handshake as initiator, `inbox.get`, inbox and pairing events) and `RelayDesktopConnectionFactory`
- `Connection/`: the `DesktopConnection` / `DesktopConnectionFactory` protocols the app depends on, plus `MockDesktopConnection`
- `Push/`: push crypto (§7.5 payloads, §7.1 registration signing), `PushGatewayClient` (`POST /v1/push/register`), `PushKeyStore` (per-desktop push keys, shared with the extension) and the `push.register` / `push.unregister` ops (§7.4)
- `Storage/KeychainStore`: raw key bytes by label (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), optionally in a shared access group

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

That unsigned build runs, but the App Group entitlement is missing, so push keys fall back to the app's own keychain group and the notification extension can't decrypt (see Push notifications). Leave out `CODE_SIGNING_ALLOWED=NO` to sign ad hoc ("Sign to Run Locally") with the entitlements.

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

## Push notifications (M3)

SPEC.md §7 is the contract. On the phone:

- **Settings → Notifications** has a master switch and toggles for *Permission requests* (`permission`), *Questions & plans* (`question`) and *Finished turns* (`done`). All three are on once the master switch is. They live in `UserDefaults` (`push.enabled`, `push.kinds`). Turning the switch on asks for notification permission. If iOS has notifications turned off for DevTool, the section says so and links to Settings.
- At launch, and when push is switched on, the app gets an APNs token and registers it with the gateway (`POST <gateway>/v1/push/register`, signed with the phone's relay key; the env is `sandbox` in Debug builds and `production` in Release). It keeps the returned `cap` in `UserDefaults` (`push.cap`), together with the token, env and gateway it was issued for. If registration fails, the error is logged and shown in Settings, and an older `cap` for the same token stays in use.
- After every session that ends its handshake with `ok`, and whenever the switches or the `cap` change, the app sends `push.register { cap, key, keyId, kinds }` to that desktop. With push off it sends `push.unregister` to the desktops it had registered with (`push.registeredDesktops`). A desktop from before M3 answers `unsupported`, which is only logged.
- **Keys:** each pairing gets its own 32-byte `key` and 8-byte `keyId` (random), created on first use and deleted when the pairing is forgotten. `PushKeyStore` keeps them as Keychain items under service `sk.awantech.devtool.push`, one per desktop ID, holding `{desktopId, key, keyId, desktopName}`, in access group `group.sk.awantech.devtool`. That is the App Group, which iOS also accepts as a keychain access group, so the extension can read the keys and nothing else of the app's. When the process isn't entitled to that group (an unsigned `CODE_SIGNING_ALLOWED=NO` build), the store falls back to the default group. The app keeps working, but the extension can't see the keys, so notifications keep their fallback text.
- **Extension:** `DevToolNotifications` reads `d`, looks up the key by the key ID in front of it, decrypts and replaces the alert with the payload's `title` and `body`. With more than one paired desktop, the desktop's name goes in the subtitle. It sets the category to `kind`, the thread to the tab, and `desktop` / `tab` / `prompt` in `userInfo`, taking `desktop` from the key rather than the payload. On any failure, or when time runs out, it delivers the original "An agent needs you".
- **Categories:** `permission` has *Allow* and *Deny* (destructive). Both require an unlocked device, and neither brings the app to the foreground. `question`, `plan` and `done` have no actions.
- **Tapping** a notification opens that chat, waiting briefly for the inbox on a cold launch. **Allow / Deny** wake the app in the background. It holds a background task, connects to the desktop through the same `AppModel` connection machinery, waits for a session and sends `chat.answer` with `{behavior:"allow"}` or `{behavior:"deny"}`. `gone` (already answered) counts as success. After 25 s it gives up and posts a local "Couldn't send your answer" notification that opens the chat.
- **In the foreground**, a push shows as a banner with sound unless that exact chat is on screen.

Entitlements are in `DevTool/DevTool.entitlements` (`aps-environment`, the App Group, and `keychain-access-groups`, which keeps the app's default keychain group at its own app ID) and `DevToolNotifications/DevToolNotifications.entitlements` (the App Group). To run on a device, the team you pick needs the Push Notifications and App Groups capabilities for both bundle IDs (`sk.awantech.devtool`, `sk.awantech.devtool.notifications`) and the group `group.sk.awantech.devtool`.

Mock mode (`-mockDesktop`) doesn't need any of this. It never contacts APNs or a gateway, and it keeps its switches in a separate defaults suite. The switch still asks for permission, so `simctl push` notifications show up, and tapping one or answering Allow/Deny works against the mock desktop.

### Launch options (Debug builds)

- `-pushGateway <url>` (or env `DEVTOOL_PUSH_GATEWAY`) registers with that gateway instead of `https://relay.devtool.awantech.sk`, e.g. a local relay's HTTP port: `-pushGateway http://127.0.0.1:8787`.
- `-fakePushToken <hex>` (or env `DEVTOOL_FAKE_PUSH_TOKEN`) skips APNs and registers that token (32 to 100 bytes of lowercase hex). A simulator can't get a token APNs accepts for our topic without our signing, but a gateway in simctl mode ignores the token.

### Testing on the simulator with a local gateway

Run the relay as a gateway that delivers with `xcrun simctl push` instead of APNs (`RELAY_APNS_MODE=simctl`, see `relay/README.md`), point the desktop at it, then:

```bash
xcrun simctl launch "$SIM" sk.awantech.devtool \
  -pushGateway http://127.0.0.1:8787 \
  -fakePushToken $(openssl rand -hex 32)
```

Pair (or resume), open Settings → Notifications and switch it on. The app registers with the gateway and sends `push.register` to the desktop. Pushes from the desktop then go through the gateway to `simctl push` and the extension. Build with the default signing ("Sign to Run Locally", no `CODE_SIGNING_ALLOWED=NO`) so the App Group entitlement is there and the extension can read the keys.

### Testing with `xcrun simctl push` directly

Without a desktop, `d` can't be sealed with a key the phone has, so the extension leaves the alert as it is. The top-level `desktop` / `tab` / `prompt` keys and `aps.category` still reach the app, which is enough to exercise tapping and Allow/Deny, e.g. against the mock desktop (`-mockDesktop`; `4f1c2b9e7d6a53108e2f9c4b1a7d3e60` is join3r-mbp):

```bash
cat > /tmp/permission.apns <<'JSON'
{
  "Simulator Target Bundle": "sk.awantech.devtool",
  "aps": { "alert": { "title": "DevTool", "body": "An agent needs you" }, "sound": "default",
           "mutable-content": 1, "category": "permission" },
  "d": "not-decryptable",
  "desktop": "4f1c2b9e7d6a53108e2f9c4b1a7d3e60", "tab": "<claude-chat tab id>", "prompt": "<prompt id>"
}
JSON
xcrun simctl push "$SIM" sk.awantech.devtool /tmp/permission.apns
```

Log output: `log stream --predicate 'subsystem == "sk.awantech.devtool"'` (categories `push`, `notifications`, `notification-service`).

## Tests

```bash
cd ios/DevToolKit
swift test
```

These run on macOS with no simulator. They load `protocol/vectors/*.json` and `protocol/vectors/official/*.json` straight from the repo (official cacophony/snow/noise-c and generated Noise IK vectors byte for byte, derivations, relay auth, pairing URIs, app-message samples), and drive `RelayDesktopConnection` against an in-process fake relay and desktop (`FakeRelay.swift`).

CryptoKit's Ed25519 signatures are randomized, not deterministic RFC 8032, so `relay-auth.json` and `push.json` signatures are checked by verification both ways instead of byte equality. Everything else in `push.json` (the signed message, the registration body with the vector's signature, payload decryption for every case, sealing with the fixed nonce, `push.*` params) matches byte for byte.

`LiveRelayIntegrationTests` runs the real pair → accept → inbox → resume flow against a live relay and `fake-desktop.ts`. It is skipped unless `DEVTOOL_RELAY_URL` is set:

```bash
DEVTOOL_RELAY_URL=ws://localhost:8787 DEVTOOL_PAIRING_URI='devtool://pair?d=…' swift test --filter LiveRelayIntegrationTests
```

## Storage

- Paired desktops go in `Application Support/DevTool/desktops.json`, and each desktop's last inbox goes in `Application Support/DevTool/inbox/<desktopId>.json`. Both use file protection until first unlock.
- Private keys go in the Keychain under service `sk.awantech.devtool.keys` through `KeychainStore`, as `device.x25519` and `device.ed25519` (raw 32 bytes each).
- Push keys go in the Keychain under service `sk.awantech.devtool.push`, access group `group.sk.awantech.devtool` (see Push notifications). The push switches and the current `cap` go in `UserDefaults`.
