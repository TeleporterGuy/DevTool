# DevTool relay

The relay connects DevTool desktops and the iOS app across the internet. Each device keeps a WebSocket open to it, authenticates with its Ed25519 key, and the relay forwards opaque frames between a desktop and the phones paired with it. Traffic is end-to-end encrypted with Noise IK between phone and desktop, so the relay can't read any of it.

It also carries push notifications (§7 of the spec): desktops send `push` over the socket, and the relay hands it to the **push gateway**, which only our hosted relay runs because only our APNs key can reach our app. A self-hosted relay forwards pushes to the hosted gateway over HTTPS.

The normative protocol is §3 of [`../protocol/SPEC.md`](../protocol/SPEC.md), summarized in [`../protocol/PROTOCOL.md`](../protocol/PROTOCOL.md). The relay reuses the message parsers, auth check and limits in `../protocol/ts`.

- **No runtime dependencies.** The WebSocket server is a small RFC 6455 implementation in `src/ws/`, on top of `node:http`. Persistence is `node:sqlite`.
- **No build step.** Node ≥ 24 runs the TypeScript sources directly (type stripping). The code sticks to erasable syntax: no `enum`, no `namespace`, no parameter properties.

## Layout

| path | what |
|---|---|
| `src/main.ts` | Entry point: reads the environment, opens the database, starts the server, shuts down on SIGTERM/SIGINT |
| `src/server.ts` | `startRelayServer()`: `node:http` + `/healthz` + the `/v1` upgrade + per-IP admission + the push HTTP API |
| `src/relay.ts` | `createRelay({ store, clock, limits, logger })`: the protocol core, independent of sockets |
| `src/store.ts` | `RelayStore` and `PushStore`, with `SqliteStore` (production) and `MemoryStore` (tests) |
| `src/push/gateway.ts` | `createPushGateway()`: registration, cap sealing, per-device budget, APNs result mapping. Also the in-process and upstream `PushForwarder`s |
| `src/push/apns.ts` | `ApnsSender`: the HTTP/2 APNs client with its ES256 provider token, the `simctl` sender and the `log` sender |
| `src/rate.ts` | Token bucket (per connection) and sliding-window IP limiter |
| `src/ws/` | RFC 6455 server side: opening handshake, frame parser/encoder, fragmentation, ping/pong, close handshake, payload cap |
| `src/log.ts`, `src/config.ts` | JSON logs, environment parsing |
| `test/` | vitest suites over real sockets on ephemeral ports |
| `Dockerfile`, `docker-compose.yml`, `deploy/Caddyfile.example` | Container and deployment |

## Run locally

```bash
cd relay
npm start                      # ws://localhost:8787/v1, database in ./data/relay.db
npm run dev                    # same, restarts on file changes, LOG_LEVEL=debug
curl localhost:8787/healthz    # → ok
```

Then point a desktop at it: DevTool Settings → Mobile → relay URL `ws://localhost:8787`, or the stand-in desktop from the repo root:

```bash
node protocol/tools/fake-desktop.ts ws://localhost:8787
```

## Environment

| variable | default | meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address. Use `127.0.0.1` behind a reverse proxy on the same host |
| `RELAY_DATA` | `./data` | Directory for `relay.db` (created if missing) |
| `RELAY_TRUST_PROXY` | unset | `1` makes the per-IP limit use the **last** `X-Forwarded-For` entry, which is what your own proxy appended. Only set it behind a proxy you control, or clients can pick their own IP |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `RELAY_PUSH_UPSTREAM` | `https://relay.devtool.awantech.sk` | Gateway that a non-gateway relay forwards `push` to. Set it to an empty string to turn push off (desktops get `unavailable`). A gateway ignores it |
| `RELAY_PUSH_SEAL_KEY` | unset | Setting it makes this relay the push gateway. 32 random bytes, base64url without padding. Every cap is sealed with it, so changing it invalidates every phone's registration until the phone registers again |
| `RELAY_APNS_MODE` | `apns` if `RELAY_APNS_KEY_FILE` is set | Gateway only. `apns` talks to Apple, `simctl` pushes to a local iOS simulator with `xcrun simctl push`, `log` accepts every push and only logs it |
| `RELAY_APNS_KEY_FILE` | unset | `apns` mode: path to the `.p8` auth key from Apple |
| `RELAY_APNS_KEY_ID` | unset | `apns` mode: the key's 10-character ID |
| `RELAY_APNS_TEAM_ID` | unset | `apns` mode: the 10-character team ID |
| `RELAY_APNS_TOPIC` | `sk.awantech.devtool` | `apns` and `simctl` modes: the app's bundle ID |
| `RELAY_SIMCTL_DEVICE` | `booted` | `simctl` mode: the simulator's UDID |

Logs are one JSON object per line on stdout (`ts`, `level`, `event`, plus fields such as `id`, `role`, `ip`, `code`). Frame data, tokens and signatures are never logged, and neither are APNs tokens, caps, push payloads or keys. Startup logs which push role is active (`push-gateway` with its mode, `push-forward` with the upstream, or `push-off`), and a bad push setting stops the relay with a message on stderr.

## Push gateway

The gateway serves `POST /v1/push/register` (phone → gateway: a signed APNs token in, a sealed `cap` out) and `POST /v1/push/send` (`{cap, data}` from another relay → `{result}`), and handles `push` from its own desktops in-process. Its only state is the `push_devices` table in `relay.db`: a generation counter per device, which every registration bumps. The APNs token lives only inside the cap. On a relay that isn't a gateway both paths answer 503.

For a gateway that talks to Apple:

```bash
RELAY_PUSH_SEAL_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
RELAY_APNS_KEY_FILE=/secrets/AuthKey_ABCDEF1234.p8 RELAY_APNS_KEY_ID=ABCDEF1234 RELAY_APNS_TEAM_ID=TEAM123456 \
npm start
```

Keep the seal key stable across restarts (store it with the other secrets), or every cap dies with it. The HTTP/2 client keeps one session per APNs host and reconnects after it closes. Each request times out after 10 s.

To try push against a local iOS simulator, run a gateway in `simctl` mode and point the app's gateway and the desktop's relay at it. The simulator can't receive real APNs pushes, so `xcrun simctl push` stands in for Apple, with the same JSON body. The token and `env` in the cap are ignored.

```bash
PORT=8791 HOST=127.0.0.1 RELAY_DATA=/tmp/devtool-gw \
RELAY_PUSH_SEAL_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
RELAY_APNS_MODE=simctl RELAY_SIMCTL_DEVICE=booted \
node --disable-warning=ExperimentalWarning relay/src/main.ts
```


## Test and typecheck

```bash
cd relay
npm install          # on a machine with registry access
npm test             # vitest run
npm run typecheck    # tsc --noEmit (includes ../protocol/ts)
```

In this monorepo you can skip `npm install`. The dev dependencies (vitest, typescript, @types/node) are the same ones the root package installs, and both `vitest` and `tsc` resolve from `../node_modules`. `npm test` and `npm run typecheck` find them because npm puts every ancestor `node_modules/.bin` on `PATH`. You can also call them directly: `../node_modules/.bin/vitest run` and `../node_modules/.bin/tsc -p tsconfig.json`.

The suites:

- `test/relay.test.ts` covers HTTP routing, auth (success, bad signature, wrong role, non-hello, 10 s timeout), offers (one use, expired, replaced, wrong token), pending phones (routing both ways, reconnect, lapse), authorize (persisted, and still there after a restart on the same SQLite file), revoke, `forbidden` and `offline` routing errors, presence and `lastSeen`, watch filtering, max frame size, rate limiting, per-IP limits with and without `X-Forwarded-For`, replacing a duplicate connection, idle timeout and shutdown.
- `test/integration.test.ts` runs `protocol/tools/fake-desktop-core.ts` and a phone built from `protocol/ts` through the relay: a real Noise IK pair handshake, accept, `authorize`, the inbox, a resume handshake after reconnecting, a stale QR code refused, and revoke.
- `test/ws.test.ts` covers the WebSocket layer: Node's own `WebSocket` client end to end, fragmentation, ping during a fragmented message, and the payload cap enforced from the frame header alone. It also checks unmasked frames, invalid UTF-8, stray continuations, the close handshake both ways, and bad upgrade requests.
- `test/store.test.ts` covers both stores (pairs and push generations), the token bucket, the IP limiter and config parsing.
- `test/push.test.ts` covers the gateway (registration, skew, bad signatures, the per-IP limit, generations, every `send` result and the APNs response mapping), the HTTP/2 APNs client against a local cleartext fake (headers, body, the ES256 token and its 50-minute refresh, reconnects, timeouts), the `simctl` and `log` senders, `push` over the socket (forbidden for phones, `unavailable`, in-process, relay A forwarding to gateway B, upstream failures, the in-flight cap), the push HTTP endpoints, and push config.

## Docker

The image copies `relay/` and `protocol/ts`, so the build context is the **repo root**:

```bash
docker build -f relay/Dockerfile -t devtool-relay .
docker run --rm -p 8787:8787 -v devtool-relay-data:/data devtool-relay
```

Prebuilt images for `linux/amd64` and `linux/arm64` are published to `ghcr.io/join3r/devtool-relay` by `.github/workflows/mobile.yml` on every push to master that touches the relay or protocol (`latest` and `sha-<commit>` tags). Pull requests build the image without pushing it.

Or, for local development, `docker compose -f relay/docker-compose.yml up --build`. That serves port 8787 with a named volume `relay-data`.

The image is `node:24-alpine` running as the unprivileged `node` user. It declares `VOLUME /data` with `RELAY_DATA=/data`, has a `HEALTHCHECK` on `/healthz`, and runs no `npm install`, because there is nothing to install. The root `.dockerignore` keeps the rest of the repo out of the build context.

## Deploy on a small VPS with Caddy

1. Install Docker and Caddy, and point a DNS `A`/`AAAA` record (for example `relay.devtool.awantech.sk`) at the machine. Open ports 80 and 443.
2. Build or pull the image, then run it on loopback only, trusting Caddy's `X-Forwarded-For`:
   ```bash
   docker run -d --name devtool-relay --restart unless-stopped \
     -p 127.0.0.1:8787:8787 -e RELAY_TRUST_PROXY=1 \
     -v devtool-relay-data:/data devtool-relay
   ```
3. Copy `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile` (change the host name if needed) and `systemctl reload caddy`. Caddy obtains the TLS certificate itself and proxies the WebSocket upgrade.
4. Check it: `curl https://relay.devtool.awantech.sk/healthz` → `ok`. Desktops and phones use `wss://relay.devtool.awantech.sk`.

For the hosted gateway, add the push settings to step 2 and mount the key read-only, for example `-e RELAY_PUSH_SEAL_KEY=... -e RELAY_APNS_KEY_FILE=/secrets/AuthKey.p8 -e RELAY_APNS_KEY_ID=... -e RELAY_APNS_TEAM_ID=... -v /etc/devtool/AuthKey.p8:/secrets/AuthKey.p8:ro`. The `node` user in the container must be able to read the file. A self-hosted relay needs nothing: it forwards pushes to `https://relay.devtool.awantech.sk` by default.

The relay sends 1001 to every socket on `SIGTERM` (`docker stop`), and clients reconnect with backoff. Back up the `/data` volume if you want pairings to survive losing the machine. If it's lost, users pair their phones again.

## What the relay can and can't see

**Sees:** device IDs and Ed25519 public keys, which desktop is paired with which phone (and when), client IPs, connection and disconnection times, and the size and timing of every frame. During pairing it holds `SHA-256(relayToken)` in memory. Only the pairs table is written to disk.

**Can't see:** anything inside `frame.data`. That covers project, task and tab names, statuses, prompts and code, which are all Noise-encrypted between phone and desktop. It also never gets the pairing secret or the `pairProof`, so it can't forge a pairing. Even a malicious relay that let a stranger's phone through would fail the desktop's proof check inside the handshake. A relay can drop, delay or refuse to route frames, but it can't read or alter them undetected.

## Behaviour beyond the wire spec

These are decisions the original rules left open. They are recorded in SPEC.md §3.7:

- A phone whose `pair` token doesn't match a live offer still gets `ready`, followed by `error forbidden` with `to` set to the desktop. It isn't pending.
- Pending status belongs to the (desktop, phone) pair until the offer's `exp` (clamped to 15 min). It survives a phone reconnect without the token. When it lapses, the phone gets `error forbidden "pairing window expired"` and the desktop gets `peer offline`. The phone is then closed with **4403**, unless it's authorized or pending with another desktop.
- A desktop's offer is dropped when the desktop disconnects or is replaced.
- `authorize` checks that `pub` hashes to `phone` (`bad-request`) and equals the key that phone authenticated with (`forbidden`). It has no success reply. `revoke` is idempotent and also cancels a pending phone.
- `watch` replaces the previous set, carries at most 256 IDs, and reports `offline` with `lastSeen` when known.
- On `ready` a desktop gets `peer` for each authorized or pending phone that is online, or offline with a known `lastSeen`.
- A replaced connection (4409) doesn't announce `offline`. The new one announces `online`.
- Idle timeout and shutdown close with **1001**. Every message, including `hello` and `ping`, costs a rate token. The first message over the limit is dropped with `error rate`, and another within 10 s closes with 4429. Refused connection attempts count toward the per-IP limit, which answers HTTP 429 at the upgrade.
- `forbidden` is checked before `offline`, so unpaired devices can't probe presence. Binary frames and malformed JSON after auth get `bad-request` and the socket stays open. Role violations (a phone sending `offer`, a desktop sending `watch`) get `forbidden`.
