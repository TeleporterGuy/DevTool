import { spawn } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect, constants } from 'node:http2'
import type { ClientHttp2Session, IncomingHttpHeaders } from 'node:http2'
import { b64uEncode, utf8Encode } from '../../../protocol/ts/index.ts'
import type { PushEnv } from '../../../protocol/ts/index.ts'
import { silentLogger } from '../log.ts'
import type { Logger } from '../log.ts'
import type { Clock } from '../relay.ts'
import { systemClock } from '../relay.ts'

/**
 * The gateway's last hop (§7.3): something that hands one notification to Apple.
 * `createApnsSender` is the real HTTP/2 client; `createSimctlSender` pushes to a local
 * iOS simulator with `xcrun simctl push`; `createLogSender` only logs.
 */

export interface ApnsRequest {
  /** For logs only. */
  device: string
  /** APNs device token, lowercase hex. */
  token: string
  env: PushEnv
  /** The sealed payload, passed through as `d`. */
  data: string
}

/** What APNs answered: its HTTP status and, on failure, its `reason`. */
export interface ApnsResponse {
  status: number
  reason?: string
}

export interface ApnsSender {
  readonly mode: 'apns' | 'simctl' | 'log'
  /** Rejects on a transport failure or timeout. */
  send(request: ApnsRequest): Promise<ApnsResponse>
  close(): void
}

export const APNS_HOSTS: Readonly<Record<PushEnv, string>> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com'
}

export const DEFAULT_APNS_TOPIC = 'sk.awantech.devtool'
/** §7.3: refresh the provider token every 50 minutes (Apple accepts up to 60). */
export const APNS_JWT_TTL_MS = 50 * 60 * 1000
export const APNS_TIMEOUT_MS = 10_000

/** The §7.3 body. The alert is the fallback the phone shows if it can't decrypt `d`. */
export function apnsPayload(data: string): string {
  return JSON.stringify({
    aps: { alert: { title: 'DevTool', body: 'An agent needs you' }, sound: 'default', 'mutable-content': 1 },
    d: data
  })
}

/** Reads a `.p8` (PKCS#8 PEM) APNs auth key and checks that it is a P-256 EC key. */
export function loadApnsKey(path: string): KeyObject {
  let pem: string
  try {
    pem = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`RELAY_APNS_KEY_FILE: cannot read ${path}: ${(err as Error).message}`)
  }
  return parseApnsKey(pem, `RELAY_APNS_KEY_FILE (${path})`)
}

export function parseApnsKey(pem: string, what = 'APNs key'): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey({ key: pem, format: 'pem' })
  } catch {
    throw new Error(`${what} is not a PEM private key`)
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`${what} must be an EC P-256 key (the .p8 file from Apple)`)
  }
  return key
}

/** A provider token: ES256 over `{alg, kid}.{iss, iat}`. */
export function apnsJwt(key: KeyObject, keyId: string, teamId: string, iatSeconds: number): string {
  const header = b64uEncode(utf8Encode(JSON.stringify({ alg: 'ES256', kid: keyId })))
  const claims = b64uEncode(utf8Encode(JSON.stringify({ iss: teamId, iat: iatSeconds })))
  const input = `${header}.${claims}`
  const signature = sign('sha256', utf8Encode(input), { key, dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64uEncode(signature)}`
}

export interface ApnsSenderOptions {
  key: KeyObject
  keyId: string
  teamId: string
  topic: string
  /** Override per environment, e.g. `http://127.0.0.1:port` for a cleartext test server. */
  hosts?: Partial<Record<PushEnv, string>>
  timeoutMs?: number
  clock?: Clock
  logger?: Logger
}

/** Reasons after which the cached provider token is thrown away. */
const TOKEN_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken', 'MissingProviderToken'])

export function createApnsSender(options: ApnsSenderOptions): ApnsSender {
  const clock = options.clock ?? systemClock
  const log = options.logger ?? silentLogger
  const timeoutMs = options.timeoutMs ?? APNS_TIMEOUT_MS
  const hosts: Record<PushEnv, string> = { ...APNS_HOSTS, ...options.hosts }
  /** One HTTP/2 session per origin, replaced after it closes or gets GOAWAY. */
  const sessions = new Map<string, ClientHttp2Session>()
  let jwt: { value: string; at: number } | null = null
  let closed = false

  function token(): string {
    const now = clock.now()
    if (!jwt || now - jwt.at >= APNS_JWT_TTL_MS || now < jwt.at) {
      jwt = { value: apnsJwt(options.key, options.keyId, options.teamId, Math.floor(now / 1000)), at: now }
    }
    return jwt.value
  }

  function session(origin: string): ClientHttp2Session {
    const existing = sessions.get(origin)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const s = connect(origin)
    const forget = (): void => {
      if (sessions.get(origin) === s) sessions.delete(origin)
    }
    s.on('error', (err) => {
      log.warn('apns-session-error', { origin, error: err.message })
      forget()
    })
    s.on('goaway', forget)
    s.on('close', forget)
    sessions.set(origin, s)
    return s
  }

  return {
    mode: 'apns',
    send(request) {
      if (closed) return Promise.reject(new Error('sender closed'))
      const nowSeconds = Math.floor(clock.now() / 1000)
      const body = apnsPayload(request.data)
      return new Promise<ApnsResponse>((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          fn()
        }
        let s: ClientHttp2Session
        try {
          s = session(hosts[request.env])
        } catch (err) {
          reject(err)
          return
        }
        const req = s.request({
          ':method': 'POST',
          ':path': `/3/device/${request.token}`,
          authorization: `bearer ${token()}`,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(nowSeconds + 3600),
          'apns-topic': options.topic,
          'content-type': 'application/json'
        })
        const timer = setTimeout(() => {
          finish(() => reject(new Error('APNs request timed out')))
          req.close(constants.NGHTTP2_CANCEL)
        }, timeoutMs)
        let status = 0
        const chunks: Buffer[] = []
        req.on('response', (headers: IncomingHttpHeaders) => {
          status = Number(headers[':status'])
        })
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          let reason: string | undefined
          if (chunks.length > 0) {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown }
              if (typeof parsed.reason === 'string') reason = parsed.reason
            } catch {
              // No JSON body; the status says enough.
            }
          }
          if (reason && TOKEN_REASONS.has(reason)) jwt = null
          finish(() => resolve(reason === undefined ? { status } : { status, reason }))
        })
        req.on('error', (err) => finish(() => reject(err)))
        req.on('close', () => finish(() => reject(new Error(`APNs stream closed (${req.rstCode})`))))
        req.end(body)
      })
    },
    close() {
      closed = true
      for (const s of sessions.values()) s.close()
      sessions.clear()
    }
  }
}

export interface SimctlSenderOptions {
  /** Simulator UDID, or `booted`. */
  device: string
  topic: string
  /** The command before `<device> <topic> -`. Tests replace it. */
  command?: string[]
  timeoutMs?: number
  logger?: Logger
}

/**
 * Local development: `xcrun simctl push <device> <topic> -` with the §7.3 body on stdin.
 * The simulator can't receive real APNs pushes, so this stands in for Apple.
 */
export function createSimctlSender(options: SimctlSenderOptions): ApnsSender {
  const log = options.logger ?? silentLogger
  const [cmd, ...prefix] = options.command ?? ['xcrun', 'simctl', 'push']
  const timeoutMs = options.timeoutMs ?? APNS_TIMEOUT_MS
  return {
    mode: 'simctl',
    send(request) {
      return new Promise<ApnsResponse>((resolve, reject) => {
        const child = spawn(cmd, [...prefix, options.device, options.topic, '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('simctl push timed out'))
        }, timeoutMs)
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 500) stderr += chunk.toString('utf8')
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) {
            log.debug('simctl-pushed', { device: request.device, simulator: options.device })
            resolve({ status: 200 })
          } else {
            log.warn('simctl-failed', { device: request.device, code, stderr: stderr.trim().slice(0, 300) })
            reject(new Error(`simctl push exited with ${code}`))
          }
        })
        child.stdin.on('error', () => {})
        child.stdin.end(apnsPayload(request.data))
      })
    },
    close() {}
  }
}

/** Accepts everything and logs metadata only. For tests and dry runs. */
export function createLogSender(logger: Logger = silentLogger): ApnsSender {
  return {
    mode: 'log',
    send(request) {
      logger.info('push-logged', { device: request.device, env: request.env, bytes: request.data.length })
      return Promise.resolve({ status: 200 })
    },
    close() {}
  }
}
