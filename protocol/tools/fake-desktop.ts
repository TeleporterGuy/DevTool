#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import {
  RELAY_PATH,
  RELAY_PING_INTERVAL_MS,
  b64uDecode,
  b64uEncode,
  ed25519FromPrivate,
  encodeRelayMessage,
  generateEd25519,
  generateX25519,
  parseServerMessage,
  x25519FromPrivate
} from '../ts/index.ts'
import { FakeDesktop } from './fake-desktop-core.ts'
import type { DesktopIdentity, PairingRequest, StoredPairing } from './fake-desktop-core.ts'

/**
 * A stand-in desktop for iOS development without Electron: it pairs with a phone
 * through a relay and serves a canned, slowly changing inbox and a scripted Claude chat
 * (see fake-chat.ts).
 *
 *   node protocol/tools/fake-desktop.ts [relayUrl] [--manual] [--name NAME] [--state DIR]
 *
 * Node 23.6+ runs this directly (type stripping is on by default; older 22.x needs
 * --experimental-strip-types). `npx tsx protocol/tools/fake-desktop.ts` also works.
 */

const USAGE = `usage: node protocol/tools/fake-desktop.ts [relayUrl] [options]

  relayUrl          relay base URL (default ws://localhost:8787); /v1 is appended
  --manual          ask y/n before accepting a pairing (default: auto-accept)
  --name NAME       desktop name shown on the phone (default: fake-<hostname>)
  --state DIR       where identity.json and pairings.json live
                    (default: ~/.devtool-fake-desktop)
  --help`

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    manual: { type: 'boolean', default: false },
    name: { type: 'string' },
    state: { type: 'string' },
    help: { type: 'boolean', default: false }
  }
})
if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
if (positionals.length > 1) fail(USAGE)

const relayUrl = (positionals[0] ?? 'ws://localhost:8787').replace(/\/+$/, '')
if (!/^wss?:\/\//.test(relayUrl)) fail('relayUrl must start with ws:// or wss://')
const stateDir = values.state ?? join(homedir(), '.devtool-fake-desktop')
const name = values.name ?? `fake-${hostname().split('.')[0]}`
mkdirSync(stateDir, { recursive: true })
const identityFile = join(stateDir, 'identity.json')
const pairingsFile = join(stateDir, 'pairings.json')

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}

/** Plain b64u, like the real desktop's `enc: "none"` fallback (§1); fine for a dev tool. */
function loadIdentity(): DesktopIdentity {
  if (existsSync(identityFile)) {
    const saved = JSON.parse(readFileSync(identityFile, 'utf8')) as { x25519Priv: string; ed25519Priv: string }
    return { x25519: x25519FromPrivate(b64uDecode(saved.x25519Priv)), ed25519: ed25519FromPrivate(b64uDecode(saved.ed25519Priv)) }
  }
  const identity = { x25519: generateX25519(), ed25519: generateEd25519() }
  const saved = { enc: 'none', x25519Priv: b64uEncode(identity.x25519.priv), ed25519Priv: b64uEncode(identity.ed25519.priv) }
  writeAtomic(identityFile, JSON.stringify(saved, null, 2) + '\n')
  console.log(`created a new identity in ${identityFile}`)
  return identity
}

function loadPairings(): StoredPairing[] {
  if (!existsSync(pairingsFile)) return []
  return JSON.parse(readFileSync(pairingsFile, 'utf8')) as StoredPairing[]
}

const log = (line: string): void => console.log(`[${new Date().toLocaleTimeString()}] ${line}`)

let prompt: ReturnType<typeof createInterface> | null = null
async function approve(request: PairingRequest): Promise<boolean> {
  if (!values.manual) {
    log(`auto-accepting ${request.deviceName} (${request.app}); use --manual to be asked`)
    return true
  }
  prompt ??= createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question(`\nPair with "${request.deviceName}" (${request.app}, ${request.phoneId})? [y/N] `)
  return /^y(es)?$/i.test(answer.trim())
}

function showOffer(uri: string, exp: number): void {
  console.log('\nPairing link (valid until ' + new Date(exp * 1000).toLocaleTimeString() + '):\n')
  console.log(uri + '\n')
  // Dependency-free: draw a QR only if the `qrencode` CLI happens to be installed.
  const qr = spawnSync('qrencode', ['-t', 'ansiutf8', uri], { stdio: ['ignore', 'inherit', 'ignore'] })
  if (qr.error) {
    console.log("In the simulator use \"Paste pairing link\". For a scannable QR, install qrencode (brew install qrencode) or run: qrencode -t ansiutf8 '<link>'\n")
  }
}

let socket: WebSocket | null = null
function send(message: Parameters<typeof encodeRelayMessage>[0]): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encodeRelayMessage(message))
}

const desktop = new FakeDesktop({
  identity: loadIdentity(),
  name,
  relayUrl,
  pairings: loadPairings(),
  savePairings: (pairings) => writeAtomic(pairingsFile, JSON.stringify(pairings, null, 2) + '\n'),
  sendRelay: send,
  approve,
  onOffer: showOffer,
  log
})

log(`desktop ${desktop.id} "${name}", ${desktop.pairings.length} paired phone(s), state in ${stateDir}`)
log('canned chat on the "Claude" tab (tab-chat): send anything for the scripted turn, "long" for a >60 KB reply, "reset" to start over')

let backoff = 1000
function connect(): void {
  const url = relayUrl + RELAY_PATH
  log(`connecting to ${url}`)
  const ws = new WebSocket(url)
  socket = ws
  let ping: ReturnType<typeof setInterval> | null = null
  ws.addEventListener('open', () => {
    backoff = 1000
    ping = setInterval(() => send({ t: 'ping' }), RELAY_PING_INTERVAL_MS)
  })
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return log('ignoring a binary frame from the relay')
    try {
      const msg = parseServerMessage(event.data)
      if (msg) desktop.handleServerMessage(msg)
    } catch (err) {
      log(`bad message from relay: ${(err as Error).message}`)
    }
  })
  ws.addEventListener('close', (event) => {
    if (ping) clearInterval(ping)
    if (socket === ws) socket = null
    desktop.onDisconnected()
    log(`disconnected (${event.code}${event.reason ? ` ${event.reason}` : ''}); retrying in ${backoff / 1000}s`)
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 30_000)
  })
  // 'error' is always followed by 'close', which does the reconnecting.
  ws.addEventListener('error', () => {})
}

connect()
setInterval(() => desktop.tick(), 5000)
