import {
  PUSH_RESULTS,
  PUSH_SEND_PATH,
  PushLimits,
  ProtocolError,
  b64uDecode,
  openPushCap,
  parsePushRegisterRequest,
  sealPushCap,
  verifyPushRegister
} from '../../../protocol/ts/index.ts'
import type { PushResult } from '../../../protocol/ts/index.ts'
import { silentLogger } from '../log.ts'
import type { Logger } from '../log.ts'
import { IpLimiter, TokenBucket } from '../rate.ts'
import type { Clock, PushForwarder } from '../relay.ts'
import { systemClock } from '../relay.ts'
import type { PushStore } from '../store.ts'
import type { ApnsResponse, ApnsSender } from './apns.ts'

/**
 * The push gateway (§7.1, §7.3): seals APNs tokens into caps and turns `{cap, data}`
 * into an APNs request. Only a relay holding our APNs key runs it. Nothing here logs a
 * token, a cap, a payload or a key; device IDs are fine.
 */

export interface GatewayLimits {
  registerPerIpPerHour: number
  perDevicePerHour: number
  perDeviceBurst: number
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
  registerPerIpPerHour: PushLimits.registerPerIpPerHour,
  perDevicePerHour: PushLimits.perDevicePerHour,
  perDeviceBurst: PushLimits.perDeviceBurst
}

export interface GatewayOptions {
  store: PushStore
  /** 32 bytes. */
  sealKey: Uint8Array
  sender: ApnsSender
  clock?: Clock
  logger?: Logger
  limits?: Partial<GatewayLimits>
}

export interface HttpReply {
  status: number
  json: Record<string, unknown>
}

export interface PushGateway {
  /** `POST /v1/push/register` with the parsed JSON body. */
  register(body: unknown, ip: string): HttpReply
  /** Never rejects. */
  send(cap: string, data: string): Promise<PushResult>
  close(): void
}

const HOUR_MS = 3_600_000

/** APNs said the token is dead (§7.3). */
export function isGoneResponse(response: ApnsResponse): boolean {
  return (
    response.status === 410 ||
    (response.status === 400 && (response.reason === 'BadDeviceToken' || response.reason === 'DeviceTokenNotForTopic'))
  )
}

/** `data` as §7.2 allows it: b64u, 1–3072 characters. */
function validData(data: unknown): data is string {
  if (typeof data !== 'string' || data.length === 0 || data.length > PushLimits.dataChars) return false
  try {
    b64uDecode(data)
    return true
  } catch {
    return false
  }
}

export function createPushGateway(options: GatewayOptions): PushGateway {
  if (options.sealKey.length !== 32) throw new Error('push seal key must be 32 bytes')
  const store = options.store
  const clock = options.clock ?? systemClock
  const log = options.logger ?? silentLogger
  const limits: GatewayLimits = { ...DEFAULT_GATEWAY_LIMITS, ...options.limits }
  const sealKey = options.sealKey
  const sender = options.sender
  const ipLimiter = new IpLimiter(limits.registerPerIpPerHour, HOUR_MS)
  const buckets = new Map<string, { bucket: TokenBucket; at: number }>()

  const pruneTimer = setInterval(() => {
    const now = clock.now()
    ipLimiter.prune(now)
    // An hour untouched and the bucket is full again, so it can go.
    for (const [device, entry] of buckets) if (now - entry.at > HOUR_MS) buckets.delete(device)
  }, 10 * 60_000)
  pruneTimer.unref?.()

  function takeToken(device: string, now: number): boolean {
    let entry = buckets.get(device)
    if (!entry) {
      entry = { bucket: new TokenBucket(limits.perDevicePerHour / 3600, limits.perDeviceBurst, now), at: now }
      buckets.set(device, entry)
    }
    entry.at = now
    return entry.bucket.take(now)
  }

  async function deliver(cap: string, data: string): Promise<PushResult> {
    if (!validData(data)) return 'bad-request'
    const payload = openPushCap(sealKey, cap)
    if (!payload) return 'bad-request'
    const device = payload.d
    if (store.pushGeneration(device) !== payload.g) return 'gone'
    if (!takeToken(device, clock.now())) {
      log.info('push-rate', { device })
      return 'rate'
    }
    let response: ApnsResponse
    try {
      response = await sender.send({ device, token: payload.t, env: payload.e, data })
    } catch (err) {
      log.warn('push-failed', { device, env: payload.e, error: (err as Error).message })
      return 'error'
    }
    if (response.status === 200) {
      log.info('push-sent', { device, env: payload.e })
      return 'ok'
    }
    if (isGoneResponse(response)) {
      store.retirePushGeneration(device, payload.g, clock.now())
      log.info('push-gone', { device, env: payload.e, status: response.status, reason: response.reason })
      return 'gone'
    }
    log.warn('push-rejected', { device, env: payload.e, status: response.status, reason: response.reason })
    return 'error'
  }

  return {
    register(body, ip) {
      const now = clock.now()
      if (!ipLimiter.admit(ip, now)) {
        log.info('push-register-rate', { ip })
        return { status: 429, json: { error: 'rate' } }
      }
      let request
      try {
        request = parsePushRegisterRequest(body)
      } catch (err) {
        if (!(err instanceof ProtocolError)) throw err
        return { status: 400, json: { error: 'bad-request' } }
      }
      const device = verifyPushRegister(request, Math.floor(now / 1000))
      if (device === null) {
        log.info('push-register-auth', { ip })
        return { status: 401, json: { error: 'auth' } }
      }
      const generation = store.bumpPushGeneration(device, now)
      const cap = sealPushCap(sealKey, { d: device, g: generation, t: request.token, e: request.env })
      log.info('push-registered', { device, env: request.env, generation })
      return { status: 200, json: { cap } }
    },
    async send(cap, data) {
      try {
        return await deliver(cap, data)
      } catch (err) {
        log.error('push-crashed', { error: (err as Error).message })
        return 'error'
      }
    },
    close() {
      clearInterval(pruneTimer)
      sender.close()
    }
  }
}

/** This relay is the gateway: hand pushes over in-process. */
export function gatewayForwarder(gateway: PushGateway): PushForwarder {
  return { push: (cap, data) => gateway.send(cap, data) }
}

export interface UpstreamOptions {
  timeoutMs?: number
  logger?: Logger
}

/**
 * A relay that isn't the gateway (§7.2): one `POST <upstream>/v1/push/send` per push.
 * A transport failure, a timeout, a non-200 or a result we don't know is `error`.
 */
export function upstreamForwarder(upstream: string, options: UpstreamOptions = {}): PushForwarder {
  const url = upstream.replace(/\/+$/, '') + PUSH_SEND_PATH
  const timeoutMs = options.timeoutMs ?? PushLimits.upstreamTimeoutMs
  const log = options.logger ?? silentLogger
  return {
    async push(cap, data) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cap, data }),
          signal: AbortSignal.timeout(timeoutMs)
        })
        if (response.status !== 200) {
          await response.body?.cancel()
          log.warn('push-upstream-status', { status: response.status })
          return 'error'
        }
        const json = (await response.json()) as { result?: unknown }
        const result = json?.result
        if (typeof result === 'string' && (PUSH_RESULTS as readonly string[]).includes(result)) return result as PushResult
        log.warn('push-upstream-result', { result: typeof result === 'string' ? result.slice(0, 32) : typeof result })
        return 'error'
      } catch (err) {
        log.warn('push-upstream-failed', { error: (err as Error).name === 'TimeoutError' ? 'timeout' : (err as Error).message })
        return 'error'
      }
    }
  }
}
