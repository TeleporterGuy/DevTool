import { generateKeyPairSync, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { createServer as createHttp2Server } from 'node:http2'
import type { Http2Server, IncomingHttpHeaders, ServerHttp2Session, ServerHttp2Stream } from 'node:http2'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PUSH_REGISTER_PATH,
  PUSH_SEND_PATH,
  b64uDecode,
  b64uEncode,
  openPushCap,
  sealPushCap,
  signPushRegister,
  utf8Decode
} from '../../protocol/ts/index.ts'
import type { PushEnv } from '../../protocol/ts/index.ts'
import { loadConfig, parsePushConfig } from '../src/config.ts'
import {
  APNS_JWT_TTL_MS,
  apnsPayload,
  createApnsSender,
  createLogSender,
  createSimctlSender,
  loadApnsKey,
  parseApnsKey
} from '../src/push/apns.ts'
import type { ApnsRequest, ApnsResponse, ApnsSender } from '../src/push/apns.ts'
import { createPushGateway, upstreamForwarder } from '../src/push/gateway.ts'
import type { PushGateway } from '../src/push/gateway.ts'
import type { RelayServer } from '../src/server.ts'
import { MemoryStore } from '../src/store.ts'
import { TestClient, authorizedPair, makeDevice, sleep, startTestRelay, tempDir } from './helpers.ts'
import type { Device } from './helpers.ts'

const SEAL = new Uint8Array(32).fill(5)
const TOKEN = 'ab'.repeat(32)
const DATA = b64uEncode(new Uint8Array(40).fill(1))

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})

function fakeClock(start = 1_700_000_000_000) {
  const clock = { t: start, now: () => clock.t }
  return clock
}

/** Records every request and answers with whatever `respond` returns. */
function fakeSender(respond: (r: ApnsRequest) => ApnsResponse | Promise<ApnsResponse> = () => ({ status: 200 })) {
  const requests: ApnsRequest[] = []
  const sender: ApnsSender = {
    mode: 'log',
    async send(r) {
      requests.push(r)
      return respond(r)
    },
    close() {}
  }
  return { sender, requests }
}

function registerBody(device: Device, ts: number, env: PushEnv = 'production', token = TOKEN) {
  return signPushRegister(device.ed.priv, device.ed.pub, token, env, ts)
}

function makeGateway(opts: { sender?: ApnsSender; clock?: ReturnType<typeof fakeClock>; store?: MemoryStore } = {}) {
  const clock = opts.clock ?? fakeClock()
  const store = opts.store ?? new MemoryStore()
  const fake = fakeSender()
  const gateway = createPushGateway({ store, sealKey: SEAL, sender: opts.sender ?? fake.sender, clock })
  cleanups.push(() => gateway.close())
  return { gateway, clock, store, requests: fake.requests }
}

function registerCap(gateway: PushGateway, device: Device, nowMs: number, env: PushEnv = 'production'): string {
  const reply = gateway.register(registerBody(device, Math.floor(nowMs / 1000), env), '10.0.0.1')
  expect(reply.status).toBe(200)
  return reply.json.cap as string
}

describe('gateway registration (§7.1)', () => {
  it('seals a cap for the signing device', () => {
    const { gateway, clock } = makeGateway()
    const phone = makeDevice()
    const reply = gateway.register(registerBody(phone, Math.floor(clock.t / 1000), 'sandbox'), '1.2.3.4')
    expect(reply.status).toBe(200)
    expect(openPushCap(SEAL, reply.json.cap as string)).toEqual({ d: phone.id, g: 1, t: TOKEN, e: 'sandbox' })
  })

  it('refuses a ts outside 300 s and a bad signature with 401', () => {
    const { gateway, clock } = makeGateway()
    const phone = makeDevice()
    const now = Math.floor(clock.t / 1000)
    expect(gateway.register(registerBody(phone, now - 300), 'a').status).toBe(200)
    expect(gateway.register(registerBody(phone, now - 301), 'a')).toEqual({ status: 401, json: { error: 'auth' } })
    expect(gateway.register(registerBody(phone, now + 301), 'a').status).toBe(401)
    const other = makeDevice()
    const forged = { ...registerBody(other, now), pub: b64uEncode(phone.ed.pub) }
    expect(gateway.register(forged, 'a').status).toBe(401)
  })

  it('refuses malformed bodies with 400', () => {
    const { gateway, clock } = makeGateway()
    const good = registerBody(makeDevice(), Math.floor(clock.t / 1000))
    for (const bad of [null, [], 'x', { ...good, token: 'zz' }, { ...good, env: 'dev' }, { ...good, ts: 'now' }, { ...good, pub: 'AA' }]) {
      expect(gateway.register(bad, 'a')).toEqual({ status: 400, json: { error: 'bad-request' } })
    }
  })

  it('allows 30 registrations per IP per hour', () => {
    const { gateway, clock } = makeGateway()
    const phone = makeDevice()
    for (let i = 0; i < 30; i++) expect(gateway.register(registerBody(phone, Math.floor(clock.t / 1000)), 'ip1').status).toBe(200)
    expect(gateway.register(registerBody(phone, Math.floor(clock.t / 1000)), 'ip1')).toEqual({ status: 429, json: { error: 'rate' } })
    // Bad requests count too.
    expect(gateway.register(null, 'ip1').status).toBe(429)
    expect(gateway.register(registerBody(phone, Math.floor(clock.t / 1000)), 'ip2').status).toBe(200)
    clock.t += 3_600_001
    expect(gateway.register(registerBody(phone, Math.floor(clock.t / 1000)), 'ip1').status).toBe(200)
  })

  it('a new registration makes older caps gone', async () => {
    const { gateway, clock, requests } = makeGateway()
    const phone = makeDevice()
    const first = registerCap(gateway, phone, clock.t)
    expect(await gateway.send(first, DATA)).toBe('ok')
    const second = registerCap(gateway, phone, clock.t)
    expect(openPushCap(SEAL, second)?.g).toBe(2)
    expect(await gateway.send(first, DATA)).toBe('gone')
    expect(await gateway.send(second, DATA)).toBe('ok')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual({ device: phone.id, token: TOKEN, env: 'production', data: DATA })
  })
})

describe('gateway delivery (§7.3)', () => {
  it('bad-request for caps it did not seal and for bad data', async () => {
    const { gateway, clock, requests } = makeGateway()
    const cap = registerCap(gateway, makeDevice(), clock.t)
    const foreign = sealPushCap(new Uint8Array(32).fill(6), { d: 'a'.repeat(32), g: 1, t: TOKEN, e: 'production' })
    expect(await gateway.send('nope', DATA)).toBe('bad-request')
    expect(await gateway.send(foreign, DATA)).toBe('bad-request')
    expect(await gateway.send(cap, '')).toBe('bad-request')
    expect(await gateway.send(cap, 'not base64!')).toBe('bad-request')
    expect(await gateway.send(cap, 'A'.repeat(3076))).toBe('bad-request')
    expect(requests).toHaveLength(0)
  })

  it('gone for a cap of a device that never registered here', async () => {
    const { gateway } = makeGateway()
    const cap = sealPushCap(SEAL, { d: 'a'.repeat(32), g: 1, t: TOKEN, e: 'production' })
    expect(await gateway.send(cap, DATA)).toBe('gone')
  })

  it('rate after a burst of 20, then one a minute', async () => {
    const { gateway, clock, requests } = makeGateway()
    const cap = registerCap(gateway, makeDevice(), clock.t)
    const other = registerCap(gateway, makeDevice(), clock.t)
    for (let i = 0; i < 20; i++) expect(await gateway.send(cap, DATA)).toBe('ok')
    expect(await gateway.send(cap, DATA)).toBe('rate')
    expect(await gateway.send(other, DATA)).toBe('ok')
    clock.t += 59_000
    expect(await gateway.send(cap, DATA)).toBe('rate')
    clock.t += 1_000
    expect(await gateway.send(cap, DATA)).toBe('ok')
    expect(await gateway.send(cap, DATA)).toBe('rate')
    expect(requests).toHaveLength(22)
  })

  it('maps APNs answers and retires dead tokens', async () => {
    let answer: ApnsResponse | Error = { status: 200 }
    const fake = fakeSender(() => {
      if (answer instanceof Error) throw answer
      return answer
    })
    const { gateway, clock } = makeGateway({ sender: fake.sender })
    const cases: Array<[ApnsResponse | Error, string]> = [
      [{ status: 200 }, 'ok'],
      [{ status: 400, reason: 'BadTopic' }, 'error'],
      [{ status: 403, reason: 'InvalidProviderToken' }, 'error'],
      [{ status: 429, reason: 'TooManyRequests' }, 'error'],
      [{ status: 500, reason: 'InternalServerError' }, 'error'],
      [new Error('socket hang up'), 'error'],
      [{ status: 410, reason: 'Unregistered' }, 'gone'],
      [{ status: 400, reason: 'BadDeviceToken' }, 'gone'],
      [{ status: 400, reason: 'DeviceTokenNotForTopic' }, 'gone']
    ]
    for (const [response, expected] of cases) {
      const cap = registerCap(gateway, makeDevice(), clock.t)
      answer = response
      expect(await gateway.send(cap, DATA)).toBe(expected)
      if (expected === 'gone') {
        // The cap stays dead: APNs isn't asked again.
        const before = fake.requests.length
        answer = { status: 200 }
        expect(await gateway.send(cap, DATA)).toBe('gone')
        expect(fake.requests.length).toBe(before)
      }
    }
  })

  it('a dead token does not kill a registration that raced ahead of it', async () => {
    const store = new MemoryStore()
    let release: (r: ApnsResponse) => void = () => {}
    const fake = fakeSender(() => new Promise<ApnsResponse>((resolve) => (release = resolve)))
    const { gateway, clock } = makeGateway({ sender: fake.sender, store })
    const phone = makeDevice()
    const old = registerCap(gateway, phone, clock.t)
    const pending = gateway.send(old, DATA)
    await sleep(0)
    const fresh = registerCap(gateway, phone, clock.t)
    release({ status: 410 })
    expect(await pending).toBe('gone')
    expect(store.pushGeneration(phone.id)).toBe(openPushCap(SEAL, fresh)!.g)
  })
})

// ---- APNs HTTP/2 client against a local cleartext fake ----------------------------

interface Seen {
  headers: IncomingHttpHeaders
  body: string
}

async function fakeApns(respond: (seen: Seen, stream: ServerHttp2Stream) => void = (_s, stream) => {
  stream.respond({ ':status': 200, 'apns-id': 'x' })
  stream.end()
}) {
  const seen: Seen[] = []
  const sessions: ServerHttp2Session[] = []
  const server: Http2Server = createHttp2Server()
  server.on('session', (s) => sessions.push(s))
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => {
      const entry = { headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(entry)
      respond(entry, stream as ServerHttp2Stream)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sessions) s.destroy()
        server.close(() => resolve())
      })
  )
  return { url, seen, sessions }
}

function ecKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { privateKey, publicKey, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }
}

function decodeJwt(authorization: string | string[] | undefined) {
  expect(typeof authorization).toBe('string')
  const [scheme, jwt] = (authorization as string).split(' ')
  expect(scheme).toBe('bearer')
  const [h, c, s] = jwt.split('.')
  return {
    jwt,
    header: JSON.parse(utf8Decode(b64uDecode(h))),
    claims: JSON.parse(utf8Decode(b64uDecode(c))),
    input: `${h}.${c}`,
    signature: b64uDecode(s)
  }
}

describe('APNs HTTP/2 sender', () => {
  it('sends the §7.3 request with a valid ES256 provider token', async () => {
    const prod = await fakeApns()
    const sandbox = await fakeApns((_s, stream) => {
      stream.respond({ ':status': 410 })
      stream.end(JSON.stringify({ reason: 'Unregistered', timestamp: 1 }))
    })
    const key = ecKey()
    const clock = fakeClock(1_700_000_000_500)
    const sender = createApnsSender({
      key: parseApnsKey(key.pem), keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 'sk.awantech.devtool',
      hosts: { production: prod.url, sandbox: sandbox.url }, clock
    })
    cleanups.push(() => sender.close())

    expect(await sender.send({ device: 'd', token: TOKEN, env: 'production', data: DATA })).toEqual({ status: 200 })
    const [req] = prod.seen
    expect(req.headers[':method']).toBe('POST')
    expect(req.headers[':path']).toBe(`/3/device/${TOKEN}`)
    expect(req.headers['apns-push-type']).toBe('alert')
    expect(req.headers['apns-priority']).toBe('10')
    expect(req.headers['apns-expiration']).toBe(String(1_700_000_000 + 3600))
    expect(req.headers['apns-topic']).toBe('sk.awantech.devtool')
    expect(JSON.parse(req.body)).toEqual({
      aps: { alert: { title: 'DevTool', body: 'An agent needs you' }, sound: 'default', 'mutable-content': 1 },
      d: DATA
    })
    expect(req.body).toBe(apnsPayload(DATA))
    const jwt = decodeJwt(req.headers.authorization)
    expect(jwt.header).toEqual({ alg: 'ES256', kid: 'ABCDEF1234' })
    expect(jwt.claims).toEqual({ iss: 'TEAM123456', iat: 1_700_000_000 })
    expect(jwt.signature.length).toBe(64)
    expect(verify('sha256', Buffer.from(jwt.input), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature)).toBe(true)

    expect(await sender.send({ device: 'd', token: TOKEN, env: 'sandbox', data: DATA })).toEqual({ status: 410, reason: 'Unregistered' })
    expect(sandbox.seen).toHaveLength(1)
    expect(prod.seen).toHaveLength(1)
  })

  it('reuses the provider token for 50 minutes, then refreshes it', async () => {
    const apns = await fakeApns()
    const clock = fakeClock()
    const sender = createApnsSender({
      key: parseApnsKey(ecKey().pem), keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 't', hosts: { production: apns.url }, clock
    })
    cleanups.push(() => sender.close())
    const send = () => sender.send({ device: 'd', token: TOKEN, env: 'production', data: DATA })
    await send()
    clock.t += APNS_JWT_TTL_MS - 1
    await send()
    clock.t += 1
    await send()
    const jwts = apns.seen.map((s) => decodeJwt(s.headers.authorization))
    expect(jwts[1].jwt).toBe(jwts[0].jwt)
    expect(jwts[2].jwt).not.toBe(jwts[0].jwt)
    expect(jwts[2].claims.iat).toBe(jwts[0].claims.iat + APNS_JWT_TTL_MS / 1000)
    // One HTTP/2 session for all three.
    expect(apns.sessions).toHaveLength(1)
  })

  it('reconnects after the server closes the session', async () => {
    const apns = await fakeApns()
    const sender = createApnsSender({
      key: parseApnsKey(ecKey().pem), keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 't', hosts: { production: apns.url }
    })
    cleanups.push(() => sender.close())
    const send = () => sender.send({ device: 'd', token: TOKEN, env: 'production', data: DATA })
    expect((await send()).status).toBe(200)
    apns.sessions[0].goaway()
    await sleep(50)
    expect((await send()).status).toBe(200)
    apns.sessions[1].destroy()
    await sleep(50)
    expect((await send()).status).toBe(200)
    expect(apns.sessions).toHaveLength(3)
  })

  it('times out a request APNs never answers', async () => {
    const apns = await fakeApns(() => {})
    const sender = createApnsSender({
      key: parseApnsKey(ecKey().pem), keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 't', hosts: { production: apns.url }, timeoutMs: 100
    })
    cleanups.push(() => sender.close())
    await expect(sender.send({ device: 'd', token: TOKEN, env: 'production', data: DATA })).rejects.toThrow(/timed out/)
  })

  it('rejects when APNs is unreachable', async () => {
    const sender = createApnsSender({
      key: parseApnsKey(ecKey().pem), keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 't', hosts: { production: 'http://127.0.0.1:1' }
    })
    cleanups.push(() => sender.close())
    await expect(sender.send({ device: 'd', token: TOKEN, env: 'production', data: DATA })).rejects.toThrow()
  })

  it('maps through the gateway: 400 BadDeviceToken is gone', async () => {
    const apns = await fakeApns((_s, stream) => {
      stream.respond({ ':status': 400 })
      stream.end(JSON.stringify({ reason: 'BadDeviceToken' }))
    })
    const sender = createApnsSender({
      key: parseApnsKey(ecKey().pem), keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 't', hosts: { production: apns.url }
    })
    const { gateway } = makeGateway({ sender, clock: fakeClock(Date.now()) })
    const cap = registerCap(gateway, makeDevice(), Date.now())
    expect(await gateway.send(cap, DATA)).toBe('gone')
    expect(await gateway.send(cap, DATA)).toBe('gone')
    expect(apns.seen).toHaveLength(1)
  })

  it('loads a .p8 file and refuses keys that are not P-256', () => {
    const dir = tempDir()
    cleanups.push(() => dir.remove())
    const good = `${dir.path}/AuthKey.p8`
    writeFileSync(good, ecKey().pem)
    expect(loadApnsKey(good).asymmetricKeyType).toBe('ec')
    const rsa = `${dir.path}/rsa.pem`
    writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
    expect(() => loadApnsKey(rsa)).toThrow(/P-256/)
    expect(() => loadApnsKey(`${dir.path}/missing.p8`)).toThrow(/cannot read/)
    expect(() => parseApnsKey('junk')).toThrow(/PEM/)
  })
})

describe('simctl and log senders', () => {
  it('runs simctl push with the body on stdin', async () => {
    const dir = tempDir()
    cleanups.push(() => dir.remove())
    const out = `${dir.path}/out.json`
    const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({argv:process.argv.slice(1),stdin:s}))})`
    const sender = createSimctlSender({ device: 'booted', topic: 'sk.awantech.devtool', command: [process.execPath, '-e', script, '--'] })
    expect(await sender.send({ device: 'd', token: TOKEN, env: 'sandbox', data: DATA })).toEqual({ status: 200 })
    const written = JSON.parse(readFileSync(out, 'utf8'))
    expect(written.argv.slice(-3)).toEqual(['booted', 'sk.awantech.devtool', '-'])
    expect(written.stdin).toBe(apnsPayload(DATA))
  })

  it('rejects when simctl fails', async () => {
    const sender = createSimctlSender({ device: 'x', topic: 't', command: [process.execPath, '-e', 'process.exit(3)', '--'] })
    await expect(sender.send({ device: 'd', token: TOKEN, env: 'sandbox', data: DATA })).rejects.toThrow(/exited with 3/)
    const missing = createSimctlSender({ device: 'x', topic: 't', command: ['/nonexistent/xcrun'] })
    await expect(missing.send({ device: 'd', token: TOKEN, env: 'sandbox', data: DATA })).rejects.toThrow()
  })

  it('log sender accepts everything and logs no secrets', async () => {
    const lines: string[] = []
    const logger = { debug() {}, info: (e: string, f?: object) => lines.push(JSON.stringify({ e, ...f })), warn() {}, error() {} }
    expect(await createLogSender(logger).send({ device: 'dev1', token: TOKEN, env: 'production', data: DATA })).toEqual({ status: 200 })
    expect(lines.join()).toContain('dev1')
    expect(lines.join()).not.toContain(TOKEN)
    expect(lines.join()).not.toContain(DATA)
  })
})

// ---- Relay socket and HTTP ---------------------------------------------------------

async function relay(options: Parameters<typeof startTestRelay>[0] = {}): Promise<RelayServer> {
  const server = await startTestRelay(options)
  cleanups.push(() => server.close())
  return server
}

function httpBase(server: RelayServer): string {
  return `http://127.0.0.1:${server.port}`
}

async function gatewayRelay(sender?: ApnsSender) {
  const store = new MemoryStore()
  const gateway = createPushGateway({ store, sealKey: SEAL, sender: sender ?? createLogSender() })
  cleanups.push(() => gateway.close())
  const server = await relay({ store, gateway })
  return { server, gateway }
}

async function httpRegister(base: string, device: Device): Promise<string> {
  const res = await fetch(base + PUSH_REGISTER_PATH, {
    method: 'POST',
    body: JSON.stringify(registerBody(device, Math.floor(Date.now() / 1000)))
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { cap: string }).cap
}

function track(client: TestClient): TestClient {
  cleanups.push(() => {
    if (!client.isClosed) client.ws.close()
  })
  return client
}

describe('push over the relay socket (§7.2)', () => {
  it('a phone may not push', async () => {
    const { server } = await gatewayRelay()
    const phone = track(await TestClient.auth(server, 'phone', makeDevice()))
    phone.send({ t: 'push', id: 1, cap: 'c', data: DATA })
    expect(await phone.nextOfType('error')).toMatchObject({ code: 'forbidden' })
  })

  it('unavailable without a gateway or upstream', async () => {
    const server = await relay()
    const desktop = track(await TestClient.auth(server, 'desktop', makeDevice()))
    desktop.send({ t: 'push', id: 7, cap: 'c', data: DATA })
    expect(await desktop.nextOfType('pushed')).toEqual({ t: 'pushed', id: 7, result: 'unavailable' })
  })

  it('malformed push is bad-request', async () => {
    const server = await relay()
    const desktop = track(await TestClient.auth(server, 'desktop', makeDevice()))
    desktop.send(JSON.stringify({ t: 'push', id: -1, cap: 'c', data: DATA }))
    expect(await desktop.nextOfType('error')).toMatchObject({ code: 'bad-request' })
  })

  it('in-process gateway: register over HTTP, push over the socket', async () => {
    const fake = fakeSender()
    const { server } = await gatewayRelay(fake.sender)
    const phone = makeDevice()
    const cap = await httpRegister(httpBase(server), phone)
    const { desktop } = await authorizedPair(server, makeDevice(), phone)
    track(desktop)
    desktop.send({ t: 'push', id: 1, cap, data: DATA })
    desktop.send({ t: 'push', id: 2, cap: 'garbage', data: DATA })
    const results = [await desktop.nextOfType('pushed'), await desktop.nextOfType('pushed')].sort((a, b) => a.id - b.id)
    expect(results).toEqual([{ t: 'pushed', id: 1, result: 'ok' }, { t: 'pushed', id: 2, result: 'bad-request' }])
    expect(fake.requests).toEqual([{ device: phone.id, token: TOKEN, env: 'production', data: DATA }])
  })

  it('end to end: relay A forwards to gateway B', async () => {
    const fake = fakeSender()
    const b = await gatewayRelay(fake.sender)
    const a = await relay({ pushUpstream: httpBase(b.server) + '/' })
    const phone = makeDevice()
    const cap = await httpRegister(httpBase(b.server), phone)
    const desktop = track(await TestClient.auth(a, 'desktop', makeDevice()))
    desktop.send({ t: 'push', id: 3, cap, data: DATA })
    expect(await desktop.nextOfType('pushed')).toEqual({ t: 'pushed', id: 3, result: 'ok' })
    await httpRegister(httpBase(b.server), phone)
    desktop.send({ t: 'push', id: 4, cap, data: DATA })
    expect(await desktop.nextOfType('pushed')).toEqual({ t: 'pushed', id: 4, result: 'gone' })
    expect(fake.requests).toHaveLength(1)
    // A itself is not a gateway.
    expect((await fetch(httpBase(a) + PUSH_REGISTER_PATH, { method: 'POST', body: '{}' })).status).toBe(503)
  })

  it('upstream failures are error', async () => {
    const statuses: number[] = [500]
    const replies: string[] = []
    let hang = false
    const http: HttpServer = createHttpServer((req, res) => {
      req.resume()
      if (hang) return
      const status = statuses.shift() ?? 200
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(replies.shift() ?? '{}')
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()) }))
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    const forward = upstreamForwarder(base, { timeoutMs: 200 })
    expect(await forward.push('c', DATA)).toBe('error')
    replies.push('{"result":"sparkly"}')
    expect(await forward.push('c', DATA)).toBe('error')
    replies.push('not json')
    expect(await forward.push('c', DATA)).toBe('error')
    replies.push('{"result":"rate"}')
    expect(await forward.push('c', DATA)).toBe('rate')
    hang = true
    expect(await forward.push('c', DATA)).toBe('error')
    expect(await upstreamForwarder('http://127.0.0.1:1').push('c', DATA)).toBe('error')
  })

  it('answers rate once too many pushes are in flight, and drops replies for closed sockets', async () => {
    const releases: Array<() => void> = []
    const server = await relay({
      limits: { maxPushesInFlight: 2 },
      pushForwarder: { push: () => new Promise((resolve) => releases.push(() => resolve('ok'))) }
    })
    const desktop = track(await TestClient.auth(server, 'desktop', makeDevice()))
    for (let id = 1; id <= 3; id++) desktop.send({ t: 'push', id, cap: 'c', data: DATA })
    expect(await desktop.nextOfType('pushed')).toEqual({ t: 'pushed', id: 3, result: 'rate' })
    releases.shift()!()
    expect(await desktop.nextOfType('pushed')).toEqual({ t: 'pushed', id: 1, result: 'ok' })
    await desktop.close()
    releases.shift()!()
    await sleep(20)
  })
})

describe('push HTTP endpoints', () => {
  it('503 on a relay that is not a gateway, whatever the method', async () => {
    const server = await relay()
    for (const path of [PUSH_REGISTER_PATH, PUSH_SEND_PATH]) {
      const res = await fetch(httpBase(server) + path, { method: 'POST', body: '{}' })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'unavailable' })
      expect((await fetch(httpBase(server) + path)).status).toBe(503)
    }
  })

  it('gateway: 405, 413, 400, 404, and healthz still works', async () => {
    const { server } = await gatewayRelay()
    const base = httpBase(server)
    const get = await fetch(base + PUSH_SEND_PATH)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    const big = await fetch(base + PUSH_REGISTER_PATH, { method: 'POST', body: 'x'.repeat(17 * 1024) })
    expect(big.status).toBe(413)
    const junk = await fetch(base + PUSH_REGISTER_PATH, { method: 'POST', body: 'not json' })
    expect(junk.status).toBe(400)
    expect(await junk.json()).toEqual({ error: 'bad-request' })
    const badReg = await fetch(base + PUSH_REGISTER_PATH, { method: 'POST', body: '{"pub":1}' })
    expect(badReg.status).toBe(400)
    expect((await fetch(base + '/v1/push/other', { method: 'POST', body: '{}' })).status).toBe(404)
    expect(await (await fetch(base + '/healthz')).text()).toBe('ok')
  })

  it('gateway send endpoint answers 200 with a result', async () => {
    const { server } = await gatewayRelay()
    const base = httpBase(server)
    const cap = await httpRegister(base, makeDevice())
    const post = async (body: unknown) => {
      const res = await fetch(base + PUSH_SEND_PATH, { method: 'POST', body: JSON.stringify(body) })
      expect(res.status).toBe(200)
      return ((await res.json()) as { result: string }).result
    }
    expect(await post({ cap, data: DATA })).toBe('ok')
    expect(await post({ cap })).toBe('bad-request')
    expect(await post([])).toBe('bad-request')
    expect(await post({ cap: 'x', data: DATA })).toBe('bad-request')
  })

  it('registration auth failures come back as 401 JSON, with the per-IP limit from X-Forwarded-For', async () => {
    const store = new MemoryStore()
    const gateway = createPushGateway({ store, sealKey: SEAL, sender: createLogSender(), limits: { registerPerIpPerHour: 2 } })
    cleanups.push(() => gateway.close())
    const server = await relay({ store, gateway, trustProxy: true })
    const base = httpBase(server)
    const phone = makeDevice()
    const post = (body: unknown, ip: string) =>
      fetch(base + PUSH_REGISTER_PATH, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body) })
    const stale = await post(registerBody(phone, Math.floor(Date.now() / 1000) - 1000), '9.9.9.9')
    expect(stale.status).toBe(401)
    expect(await stale.json()).toEqual({ error: 'auth' })
    expect((await post(registerBody(phone, Math.floor(Date.now() / 1000)), '9.9.9.9')).status).toBe(200)
    const limited = await post(registerBody(phone, Math.floor(Date.now() / 1000)), '9.9.9.9')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate' })
    expect((await post(registerBody(phone, Math.floor(Date.now() / 1000)), '8.8.8.8')).status).toBe(200)
  })
})

describe('push config', () => {
  const key = b64uEncode(new Uint8Array(32).fill(1))

  it('forwards to the hosted gateway by default; empty turns push off', () => {
    expect(loadConfig({}).push).toEqual({ role: 'forward', upstream: 'https://relay.devtool.awantech.sk' })
    expect(parsePushConfig({ RELAY_PUSH_UPSTREAM: '' })).toEqual({ role: 'off' })
    expect(parsePushConfig({ RELAY_PUSH_UPSTREAM: 'http://gw.local:8787/' })).toEqual({ role: 'forward', upstream: 'http://gw.local:8787' })
    expect(() => parsePushConfig({ RELAY_PUSH_UPSTREAM: 'ftp://x' })).toThrow(/RELAY_PUSH_UPSTREAM/)
  })

  it('a seal key makes a gateway, which needs a sender', () => {
    expect(() => parsePushConfig({ RELAY_PUSH_SEAL_KEY: key })).toThrow(/RELAY_APNS_KEY_FILE/)
    expect(() => parsePushConfig({ RELAY_PUSH_SEAL_KEY: 'short', RELAY_APNS_MODE: 'log' })).toThrow(/RELAY_PUSH_SEAL_KEY/)
    expect(parsePushConfig({ RELAY_PUSH_SEAL_KEY: key, RELAY_APNS_MODE: 'log', RELAY_PUSH_UPSTREAM: 'https://x' })).toEqual({
      role: 'gateway', sealKey: new Uint8Array(32).fill(1), sender: { mode: 'log' }
    })
    expect(parsePushConfig({ RELAY_PUSH_SEAL_KEY: key, RELAY_APNS_MODE: 'simctl' })).toMatchObject({
      sender: { mode: 'simctl', device: 'booted', topic: 'sk.awantech.devtool' }
    })
    expect(parsePushConfig({ RELAY_PUSH_SEAL_KEY: key, RELAY_APNS_MODE: 'simctl', RELAY_SIMCTL_DEVICE: 'UDID', RELAY_APNS_TOPIC: 'x.y' })).toMatchObject({
      sender: { mode: 'simctl', device: 'UDID', topic: 'x.y' }
    })
    expect(parsePushConfig({ RELAY_PUSH_SEAL_KEY: key, RELAY_APNS_KEY_FILE: '/k.p8', RELAY_APNS_KEY_ID: 'ABCDEF1234', RELAY_APNS_TEAM_ID: 'TEAM123456' })).toEqual({
      role: 'gateway',
      sealKey: new Uint8Array(32).fill(1),
      sender: { mode: 'apns', keyFile: '/k.p8', keyId: 'ABCDEF1234', teamId: 'TEAM123456', topic: 'sk.awantech.devtool' }
    })
    expect(() => parsePushConfig({ RELAY_PUSH_SEAL_KEY: key, RELAY_APNS_KEY_FILE: '/k.p8', RELAY_APNS_TEAM_ID: 'TEAM123456' })).toThrow(/RELAY_APNS_KEY_ID/)
    expect(() => parsePushConfig({ RELAY_PUSH_SEAL_KEY: key, RELAY_APNS_MODE: 'apns' })).toThrow(/RELAY_APNS_KEY_FILE/)
    expect(() => parsePushConfig({ RELAY_PUSH_SEAL_KEY: key, RELAY_APNS_MODE: 'fcm' })).toThrow(/RELAY_APNS_MODE/)
    expect(() => parsePushConfig({ RELAY_APNS_MODE: 'log' })).toThrow(/RELAY_PUSH_SEAL_KEY/)
  })
})
