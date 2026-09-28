# DevTool mobile protocol, v1 (normative)

This is the normative wire spec for the DevTool mobile client: identities, the pairing URI, the relay protocol, the encrypted phone ↔ desktop channel, and the test vectors. `protocol/ts`, `relay/`, the desktop (`src/main/mobile/`) and the iOS `DevToolKit` implement exactly what it says. If an implementation has to deviate, change this file in the same change. [PROTOCOL.md](PROTOCOL.md) is the short map.

Section numbers (§1–§6) are the ones code comments cite. §6 (chat) was added in M2; nothing had shipped yet, so it is part of protocol v1 with no version bump or feature flag.

## 1. Identities and encodings

- Every device has **two long-term keypairs**: X25519 (Noise static) and Ed25519 (relay auth). Raw 32-byte public keys.
- **Device ID** = lowercase hex of the first 16 bytes of `SHA-256(ed25519Pub)` (32 hex chars). Desktop IDs and phone IDs use the same formula.
- Binary in JSON is **base64url without padding** ("b64u") everywhere.
- Desktop identity is per config dir: `<configDir>/mobile/identity.json` holds `{ x25519Priv, ed25519Priv }` (b64u) encrypted with Electron `safeStorage` (`{ enc: "safeStorage", data: <b64 of encryptString(json)> }`). If `safeStorage.isEncryptionAvailable()` is false, write `{ enc: "none", ... }` with file mode 0600 and log a warning.

## 2. Pairing URI (QR payload)

```
devtool://pair?d=<b64u(JSON)>
JSON = {
  "v": 1,
  "relay": "wss://relay.devtool.awantech.sk",   // desktop's configured relay base URL
  "id": "<desktopId>",
  "x": "<b64u desktop x25519 pub>",
  "e": "<b64u desktop ed25519 pub>",
  "s": "<b64u 32-byte one-time secret>",
  "n": "<desktop display name, e.g. hostname>",
  "exp": <unix seconds>                            // now + 300
}
```

Two values derive from the secret `s`, using HKDF-SHA256 with an empty salt and 32-byte output:
- `relayToken = HKDF(s, info="devtool-relay-token-v1")`. Sent to the relay, which only ever sees `SHA-256(relayToken)` in the offer.
- `pairProof  = HKDF(s, info="devtool-pair-proof-v1")`. Sent only inside the Noise handshake payload. The relay can't compute it.

The secret is single-use and expires at `exp`. When a new QR is shown, the previous offer is invalidated.

Decoders reject a URI whose `v` isn't 1, whose `relay` isn't a `ws://` or `wss://` URL, whose `x`/`e`/`s` aren't 32 bytes, or whose `id` isn't `deviceId(e)`. A tampered QR could otherwise pair the phone with keys the relay routes to a different desktop. Expiry is a separate check, so the UI can say "expired" rather than "invalid". Unknown JSON fields are ignored. b64u decoding is strict everywhere: no padding, no characters outside the alphabet, and no non-canonical trailing bits.

## 3. Relay protocol v1

WebSocket at `<relay>/v1`. Text frames, one JSON object each, with discriminator `t`. The relay treats everything inside `frame.data` as opaque.

### 3.1 Auth
1. Server → `{ "t":"challenge", "nonce":"<b64u 32>" }` immediately on open.
2. Client → `{ "t":"hello", "role":"desktop"|"phone", "pub":"<b64u ed25519 pub>", "sig":"<b64u>", "pair"?: { "to":"<desktopId>", "token":"<b64u relayToken>" } }`
   - `sig = Ed25519.sign(utf8("devtool-relay-v1\n" + role + "\n" + nonce))`, where `nonce` is the b64u string exactly as received.
   - `pair` is sent only by a phone that is not yet authorized for that desktop.
3. Server → `{ "t":"ready", "id":"<deviceId>" }`, or `{ "t":"error", "code":"auth", ... }` and close (code 4401).
   - Hello must arrive within 10 s, or the server closes with 4408.

### 3.2 Desktop → server
- `{ "t":"offer", "tokenHash":"<b64u SHA-256(relayToken)>", "exp":<unix s> }`: replaces any previous offer from this desktop. Held in memory only.
- `{ "t":"authorize", "phone":"<phoneId>", "pub":"<b64u phone ed25519 pub>" }`: persists the (desktop, phone) pair. Only valid for a phone that is currently connected under this desktop's offer or already authorized.
- `{ "t":"revoke", "phone":"<phoneId>" }`: deletes the pair. If that phone is connected, the server sends it `{ "t":"peer", "id":<desktopId>, "state":"revoked" }` and drops routing.

### 3.3 Phone → server
- `{ "t":"watch", "desktops":["<desktopId>", ...] }`: subscribe to presence. Unauthorized IDs are ignored. The server replies with one `peer` message per authorized ID.

### 3.4 Both directions
- `{ "t":"frame", "to":"<id>", "data":"<b64u>" }` → recipient gets `{ "t":"frame", "from":"<id>", "data":"<b64u>" }`. Allowed only between an authorized pair, or between a desktop and a phone whose hello carried a `pair` token matching that desktop's live offer ("pending phone"). A pending phone that isn't authorized within the offer's lifetime is disconnected. The server consumes the offer (deletes it) when the first pending phone attaches, so it is one use only.
- If the recipient is offline, the server replies to the sender `{ "t":"error", "code":"offline", "to":"<id>" }` and drops the frame. **Nothing is queued.**
- Presence: `{ "t":"peer", "id":"<id>", "state":"online"|"offline"|"revoked", "lastSeen"?:<unix ms> }`. Desktops receive it for their authorized and pending phones. Phones receive it for watched desktops.
- `{ "t":"ping" }` / `{ "t":"pong" }` keepalive. Clients ping every 25 s, and the server closes sockets silent for 60 s.
- Errors: `{ "t":"error", "code":"auth"|"offline"|"forbidden"|"rate"|"bad-request", "message"?:string, "to"?:string }`.
- Forward compatibility: clients treat an error `code` they don't know as a generic error (it is still routed by `to`), and ignore a `peer` message whose `state` they don't know. The relay sends only the values listed here.

### 3.5 Limits
- Max frame 256 KiB (close 1009).
- Per connection 50 msgs/s burst 200 (error `rate`, then close 4429 on repeat).
- Per IP 20 new connections/min.
- A second connection with the same device ID replaces the first (the old one is closed with 4409).

### 3.6 Persistence
`node:sqlite` at `$RELAY_DATA/relay.db`, with one table: `pairs(desktop_id, phone_id, phone_pub, desktop_pub, created_at, PRIMARY KEY(desktop_id, phone_id))`. `lastSeen` is kept in memory.

### 3.7 Details settled by the relay implementation
The rules above left these open. `relay/` implements them, and clients may rely on them.
- **Pair token that doesn't match.** If the token is wrong, the offer is already consumed or expired, or the desktop has no offer, the phone still gets `ready`. Right after it comes `{ "t":"error", "code":"forbidden", "to":<desktopId> }`, and the phone isn't pending. A phone already authorized for `pair.to` has its `pair` ignored.
- **Pending lifetime.** Pending status belongs to the (desktop, phone) pair and lasts until the offer's `exp`. The relay clamps `exp` to at most 15 minutes ahead. An `exp` already in the past means there is no offer. Pending status survives a phone reconnect within the window, and the phone doesn't send the token again. `authorize` works for a pending phone even while it is briefly disconnected.
- **Lapse.** When the window ends without `authorize`, a connected phone gets `{ "t":"error", "code":"forbidden", "to":<desktopId>, "message":"pairing window expired" }` and the desktop gets `peer offline` for it. The relay then closes the phone with **4403**, unless the phone is authorized or pending with another desktop, in which case its socket stays open for those.
- **Offers** are dropped when the desktop's connection closes or is replaced.
- **`authorize`** returns `bad-request` if `pub` doesn't hash to `phone`, and `forbidden` if the phone is neither pending nor authorized, or if `pub` differs from the key the phone authenticated with (or the stored one). Success has no reply, and repeating it is harmless. **`revoke`** is idempotent, and it also cancels a pending phone. The phone gets `peer revoked` only if something was actually removed.
- **`watch`** replaces the previous watch set and carries at most 256 IDs (`bad-request` otherwise). For an offline desktop the reply is `offline`, with `lastSeen` when the relay knows it.
- **Desktop roster.** Right after `ready`, a desktop gets `peer online` for each authorized or pending phone that is connected, and `peer offline` with `lastSeen` for each one whose `lastSeen` the relay knows.
- **Replacement.** A connection replaced by the same device ID (4409) doesn't announce `offline`. The new connection announces `online` again.
- **Close codes.** Idle timeout and server shutdown close with **1001**. The others are 1009, 4401, 4403, 4408, 4409 and 4429. `RelayCloseCode` in `protocol/ts` (and `RelayProtocol.CloseCode` in Swift) lists all of them, 1001 as `GoingAway` and 4403 as `PairingExpired`.
- **Rate.** Every client message costs a token, including `hello` and `ping`. The first message over the limit is dropped and answered with `error rate`. Another over-limit message within 10 s of it gets `error rate` again and the relay closes with 4429. The per-IP limit counts refused attempts too. It answers HTTP 429 during the upgrade. With `RELAY_TRUST_PROXY=1` the client IP is the **last** `X-Forwarded-For` entry.
- **Errors.** The relay checks `forbidden` before `offline`, so an unpaired device can't probe presence. A frame addressed to oneself is `forbidden`. Before auth, anything except a valid `hello` (including binary or malformed JSON) gets `error auth` and 4401. After auth, binary frames and malformed messages get `bad-request` and the socket stays open. Role violations (a phone sending `offer`/`authorize`/`revoke`, or a desktop sending `watch`) get `forbidden`.
- **HTTP.** `GET /healthz` returns 200 `ok`. A plain GET on `/v1` returns 426, and every other path returns 404 (including upgrades).

## 4. Channel between phone and desktop

### 4.1 Frame envelope
`frame.data` bytes = `[kind:u8] || body`.
- `0x01` = Noise handshake message 1 (phone → desktop)
- `0x02` = Noise handshake message 2 (desktop → phone)
- `0x03` = Noise transport message (either direction)
- `0x04` = reset (either direction, empty body): "I have no session, handshake again"

### 4.2 Noise
`Noise_IK_25519_AESGCM_SHA256` exactly per the Noise spec rev 34. The phone is the initiator (it knows the desktop static key from the QR code).
- Prologue: `utf8("devtool-mobile-v1")`.
- The cipher is AES-256-GCM with a 16-byte tag. Its nonce is 4 zero bytes followed by the 64-bit **big-endian** counter (the Noise AESGCM rule, which differs from ChaChaPoly's little-endian one).
- Why not ChaChaPoly: Electron's main process uses BoringSSL, and its Node `crypto` (and WebCrypto) has no `chacha20-poly1305`. We checked on Electron 43 / Node 24.20. AES-256-GCM is available in Electron, Node and CryptoKit, so nothing is hand-rolled.
- After message 2, both sides `Split()`. The phone's send key is `k1`, and the desktop's send key is `k2`.
- A new handshake happens on every (re)connection of either side. If either side receives a transport frame it can't decrypt, or a frame with no session, it replies `0x04` and drops it. On receiving `0x04`, the phone starts a new handshake. Transport messages must not exceed 65535 bytes (the Noise limit). App messages larger than 60000 bytes are split into fragments (§6.1).

### 4.3 Handshake payloads (UTF-8 JSON)
Message 1 payload (phone):
```json
{ "v": 1, "min": 1, "app": "ios/0.1.0", "features": [],
  "kind": "pair" | "resume",
  "proof": "<b64u pairProof>",          // kind=pair only
  "deviceName": "Vladimir's iPhone",
  "ed": "<b64u phone ed25519 pub>" }
```
Message 2 payload (desktop):
```json
{ "v": 1, "min": 1, "app": "devtool/0.3.2", "features": [],
  "desktopName": "join3r-mbp",
  "result": "ok" | "pending" | "rejected" | "incompatible" | "unknown-device" }
```
Desktop rules:
- `resume`: the phone's Noise static key must match a stored pairing. If it doesn't, the desktop answers `unknown-device`.
- `pair`: the `proof` must equal (constant-time compare) the live offer's `pairProof`, and the offer must be unexpired. Then the desktop answers `pending` and asks the user to Accept.
  - On Accept, it stores the pairing, sends relay `authorize`, and sends the app message `pairing` with `status: "accepted"`.
  - On Reject, it sends `status: "rejected"`, and the relay disconnects the phone when the offer lapses.
- Version: `chosen = min(v_phone, v_desktop)`. If `chosen < max(min_phone, min_desktop)`, the answer is `incompatible`. The desktop supports N and N−1. In M1, N is 1.
  - The desktop reads only `{ v, min }` first and negotiates on that, so a phone whose payload has a future shape still gets a clean `incompatible`. Both sides must send `min <= v`, with `v >= 1`.
- The phone's `ed` must be the Ed25519 key the relay authenticated, i.e. `deviceId(ed) == frame.from`. If it isn't, the desktop answers `rejected`.
- `pair` with a wrong proof, or with no live unexpired offer, is answered `rejected`. A correct proof consumes the offer on the desktop too, so the next phone needs a new QR.
- A pending request outlives either side's socket until the consumed offer's `exp`, as the relay's pending status does (§3.7). While it lasts, the same phone (same Ed25519 and Noise static keys) handshaking `pair` again with the same proof is answered `pending` again. If the user accepted while the phone was away, that next `pair` handshake is answered `ok` once, and later ones use `resume`. When the window closes, the desktop drops the request.
- If message 1 can't be processed (decryption fails or it is truncated), the desktop drops it silently and doesn't reply `0x04`. A phone holding the wrong desktop key would otherwise loop.
- Only `ok` and `pending` establish a session. With any other result the desktop discards its handshake state after sending message 2.

### 4.4 App messages (inside transport, UTF-8 JSON, discriminator `t`)
- Phone → desktop `{ "t":"req", "id":<int>, "op":"inbox.get", "params"?: <op-specific JSON> }` (`params` is used by the §6.3 ops; `null` is absent) → desktop `{ "t":"res", "id":<int>, "ok":true, "result": Inbox }` or `{ "t":"res", "id", "ok":false, "error":{ "code", "message" } }`.
- Desktop → phone `{ "t":"evt", "e":"inbox", "seq":<int>, "inbox": Inbox }`: a full replacement, sent after any change and throttled to at most one per second. `seq` increases per session.
- Desktop → phone `{ "t":"evt", "e":"pairing", "status":"accepted"|"rejected"|"revoked" }`.
- Unknown `t`, `op` or `e` values are ignored (`req` gets `ok:false, code:"unsupported"`). Unknown fields are ignored everywhere.
- `error.code` values are `unsupported`, `bad-request`, `not-authorized` (a `req` from a phone whose pairing is still `pending`), `internal`, and from §6.3 `not-found` and `gone`. Receivers treat `code` as an open string and a missing `message` as `""`.
- A pending session (`result: "pending"` before Accept) gets no `inbox` events.
- A receiver treats an optional field set to `null` as absent. It keeps an unknown tab `type` as a string and shows an unknown `status` as `"idle"`, so a newer desktop doesn't break an older phone. Senders must still send only the values listed here.

`Inbox`:
```json
{
  "desktop": { "id": "…", "name": "join3r-mbp" },
  "generatedAt": 1790000000000,
  "projects": [{
    "id": "…", "name": "api-server", "emoji": "🚀", "remote": false,
    "tasks": [{
      "id": "…", "name": "fix-auth", "lastInteractedAt": 1790000000000,
      "attentionAt": 1790000000000,
      "tabs": [{
        "id": "…", "type": "claude-chat", "title": "Claude",
        "status": "working" | "attention" | "exited" | "idle",
        "since": 1790000000000,
        "activity": "Running Bash"
      }]
    }]
  }]
}
```
- Only agent/terminal tab types are included: `claude-chat`, `claude`, `codex`, `pi`, `terminal`. `status` is `TabActivityRegistry`'s value, with `null` mapped to `"idle"`.
- `activity` is an optional short label derived from `AgentActivity`.
- Home tasks, ephemeral-but-spent projects, and projects with `hideFromMobile: true` are excluded. Filtering happens before encryption.
- `projects` follows the desktop's `projectOrder`.

## 5. Test vectors (`protocol/vectors/`)
- `noise-ik.json`: fixed static and ephemeral keys for both sides, prologue, payloads, and the expected message 1 and message 2 bytes, then 3 transport messages each way with their expected ciphertexts. The TS implementation must *also* pass the official cacophony `Noise_IK_25519_AESGCM_SHA256` vectors, which ensures the generated vectors aren't just self-consistent.
- `derive.json`: secret → relayToken, pairProof, tokenHash. ed25519 pub → deviceId.
- `relay-auth.json`: ed25519 seed + nonce + role → sig (Ed25519 is deterministic).
- `pairing-uri.json`: object ↔ URI.
- `app-messages.json`: sample valid messages, including unknown extra fields that must be ignored.
- `fragments.json` and `chat-messages.json` (M2, §6.7).
- The field layout of every file is in `protocol/vectors/README.md`. `protocol/vectors/official/noise-ik-25519-aesgcm-sha256.json` holds the IK entries from cacophony, snow and noise-c. The generated files are rewritten by `node protocol/ts/generate-vectors.ts`, and a test fails if they have drifted.

The Swift `DevToolKit` tests load these files directly from `../../protocol/vectors`.

## 6. Chat (M2)

On the phone, a Claude chat tab (`type: "claude-chat"`) opens as a live transcript: send a message, answer permission prompts, questions and plan approvals, stop a turn, and expand a tool row. `protocol/ts/fragments.ts` and `protocol/ts/chat-messages.ts` implement this section.

### 6.1 Fragmentation (transport plaintext)

M1 transport plaintext is always UTF-8 JSON, so its first byte is `{` (0x7B). M2 adds a fragment form:

```
0x7B …                                  complete JSON message (unchanged)
0x01 id:u32be i:u16be n:u16be chunk…    fragment i of n (0-based) of message `id`
```
- A sender splits any encoded JSON message over **60000** bytes into chunks of 60000 bytes (the last one shorter), in order. A message of exactly 60000 bytes goes whole. `n` ≥ 2, and `id` is a per-session counter in each direction, starting at 0 for the first split message and wrapping at 2³².
- Chunks are bytes: a chunk boundary may fall inside a UTF-8 character. The receiver concatenates the chunks in order `0…n-1`, then parses the result as JSON. Fragments of one message are sent consecutively, but a receiver must not depend on that beyond the limits below; it accepts chunks in any order and interleaved with other messages (complete or fragmented).
- Limits: a reassembled message is at most **4 MiB** (so `n` ≤ 70), a chunk is at most 60000 bytes, at most **4** messages can be partially received at once, and a message still missing chunks **30 s** after its first one arrived is dropped.
- Violations: `n` < 2 or > 70, `i` ≥ `n`, a chunk over 60000 bytes or a header with no chunk, `n` differing from the message's earlier fragments, a chunk index received twice, or a message growing past 4 MiB. Each drops that message's partial state (and the offending fragment) and is logged. A fragment that would start a fifth partial message is dropped; the four already partial are kept. The session survives all of these.
- A session reset (`0x04`) or a new handshake clears all partial messages.
- Plaintext with any other first byte is ignored.
- A sender never produces a message over 4 MiB; if it would, it sends something smaller instead (an `internal` error for a `res`).

### 6.2 Chat view model

The desktop maps its `ChatState` (`src/shared/claude-chat.ts`) to this schema. The phone renders only this schema.

```ts
ChatView = {
  tabId: string,
  title: string,                       // tab title
  busy: boolean, turnStartedAt?: number,
  process: 'idle' | 'starting' | 'running' | 'exited', processError?: string,
  permissionMode?: string, model?: string,
  items: ChatViewItem[],               // oldest → newest, WINDOWED (see 6.4)
  hasEarlier: boolean,                 // more items exist before items[0]
  prompts: ChatViewPrompt[]            // open prompts, oldest first
}
ChatViewItem =
  | { kind: 'user', id, text, images?: number, queued?: true, failed?: true }
  | { kind: 'text', id, markdown, streaming?: true }
  | { kind: 'thinking', id, preview, streaming?: true }          // preview ≤ 300 chars
  | { kind: 'tool', id, name, summary, status: 'pending'|'running'|'waiting'|'done'|'error'|'denied',
      hasDetail: boolean, childCount?: number, lastChild?: string }
  | { kind: 'notice', id, text, tone: 'muted'|'warning'|'error' }
ChatViewPrompt =
  | { kind: 'permission', id, toolName, title, summary, detail?: string,  // detail ≤ 4000 chars (e.g. full command / diff excerpt)
      canAlwaysAllow: boolean, agent?: true }
  | { kind: 'question', id, questions: [{ question, header?, multiSelect: boolean,
      options: [{ label, description? }] }] }
  | { kind: 'plan', id, markdown }                              // ExitPlanMode
```
- `text.markdown` and `user.text` are capped at 16000 chars. Anything past that is cut, ends in "…", and is fetched through `chat.detail`.
- `tool.summary` is the same one-line label the desktop shows (`summarizeTool` / the item's `label`). `hasDetail` is true when `chat.detail` has something to show (the tool has input or a result).
- Flags (`queued`, `failed`, `streaming`, `agent`) are either `true` or absent. `images` is only sent when it is at least 1; image bytes are never sent in M2.
- Item IDs are unique within a chat and stable across events. A tool item's ID is its `tool_use` ID; a user item's is its message UUID.
- Forward compatibility, extending §4.4: an item or prompt with an unknown `kind` keeps its place and renders as "Needs a newer app" (`protocol/ts` parses it to `{ kind: 'unknown', id, unknownKind }`). An unknown tool `status` reads as `pending`, an unknown notice `tone` as `muted`, and an unknown `process` as `idle`. A known kind missing a required field makes the whole message malformed.

### 6.3 Ops (phone → desktop `req`)

All ops take `params` in the `req` object: `{ t:'req', id, op, params }`.

| op | params | result |
|---|---|---|
| `chat.open` | `{ tabId }` | `{ seq, view: ChatView }`. Subscribes this phone to the chat's events until `chat.close`, a disconnect, or another `chat.open` (**one open chat per phone**; opening a second chat silently ends the first subscription). Attaches a runtime from the tab's stored config if the chat isn't live, the same way a window attaching does (which starts the process when it isn't running). |
| `chat.close` | `{ tabId }` | `{}` |
| `chat.earlier` | `{ tabId, before: itemId, limit?: ≤100 }` | `{ items: ChatViewItem[], hasEarlier }`: up to `limit` (default and maximum 100; larger values are clamped) items immediately before `before`, oldest first. Unknown `before` → `not-found`. |
| `chat.send` | `{ tabId, text }` (≤ 32000 chars, not blank) | `{}`. Same path as the composer's send (`ClaudeChatManager.send`), which restarts a dead process. |
| `chat.answer` | `{ tabId, promptId, answer }` | `{}`. `answer` is one of: `{ behavior:'allow', always?: true }`, `{ behavior:'deny', message?: string }`, `{ behavior:'answers', answers: { [question]: string } }` for a question (every question answered; multi-select joins labels with ", ", matching what the desktop sends), or `{ behavior:'approvePlan' }` / `{ behavior:'deny', message? }` for a plan. Unknown or already-answered `promptId` → error `gone`. An answer that doesn't fit the prompt's kind → `bad-request`. |
| `chat.interrupt` | `{ tabId }` | `{}` |
| `chat.detail` | `{ tabId, itemId }` | `{ kind:'tool', input: string, result?: string }` (pretty JSON input + result text, each ≤ 200000 chars) or `{ kind:'text', markdown }` for a text, user, thinking or notice item (the full text). |

- Ops other than `chat.open` don't need the chat to be open on this phone. When the chat has no runtime yet, the desktop attaches one first, as `chat.open` does.
- Malformed `params` → `bad-request`.
- New error codes: `not-found` (unknown tab or item, a hidden project, or a tab that isn't claude-chat), `gone` (prompt already answered). A tab in a `hideFromMobile` project always answers `not-found`.

### 6.4 Events (desktop → phone)

- `{ t:'evt', e:'chat', tabId, seq, upserts: ChatViewItem[], removes: string[], prompts: ChatViewPrompt[], busy, turnStartedAt?, process, processError?, permissionMode?, model? }`
  - The phone applies `removes` first, then `upserts`. `upserts` replace items by `id`, or add them. New IDs are appended after the current last item in the order given.
  - `prompts` is always the **full** open-prompt list. The status fields are always the full current values (an absent optional field means it is now unset).
  - `seq` increases per (session, tab) and the first event after `chat.open` carries the open's `seq` + 1. A gap makes the phone call `chat.open` again. Events for a tab other than the open one are ignored.
  - The desktop computes diffs per subscription by comparing the last-sent mapped items (a content key per id) and throttles to **at most 4 events per second** per subscription, trailing, with prompts and busy/process changes flushed immediately.
  - When the transcript is replaced rather than extended (`/clear`, a reset), the desktop removes every item it sent and upserts the new window.
- Window: `chat.open` returns the **last 60 items**. Items before the window are only reachable through `chat.earlier`, which extends the window. Upserts to items older than the phone's window are not sent (the desktop tracks the oldest id sent per subscription).
- The inbox (§4.4) is unchanged. A chat tab's inbox status still comes from `TabActivityRegistry`.

### 6.7 Vectors

(§6.5 and §6.6 of the M2 plan, `docs/superpowers/plans/2026-09-28-mobile-m2-chat.md`, cover the desktop and iOS implementations; they add no wire rules.)


`protocol/vectors/fragments.json`: a message of 150000 bytes, its fragments as hex, and step-by-step receiver scenarios for the rules in §6.1. `protocol/vectors/chat-messages.json`: sample `chat.*` reqs, params and results, and `evt chat` messages, including unknown kinds and fields. Layouts are in `protocol/vectors/README.md`.
