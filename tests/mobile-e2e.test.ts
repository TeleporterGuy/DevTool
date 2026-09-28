import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MobileService } from '../src/main/mobile/mobile-service'
import { IdentityStore, type SecretEncryptor } from '../src/main/mobile/identity'
import { PairingsStore } from '../src/main/mobile/pairings-store'
import { RelayClient } from '../src/main/mobile/relay-client'
import { createNoiseChannelFactory } from '../src/main/mobile/channel'
import { createInvite } from '../src/main/mobile/invite'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import { DEFAULT_MOBILE_CONFIG, type MobileConfig, type MobileState } from '../src/shared/mobile'
import { createHomeTask, type ProjectsData } from '../src/shared/types'
import type { AppMessage, InboxEvent } from '../protocol/ts/index.ts'
import { startRelayServer, type RelayServer } from '../relay/src/server.ts'
import { MemoryStore } from '../relay/src/store.ts'
import { RelayPhone, waitFor } from './helpers/relay-phone'

/**
 * The desktop's real mobile stack — MobileService, identity, pairings, RelayClient
 * over the runtime's global WebSocket, the Noise channel — against a relay on a real
 * port, with a phone built only from protocol/ts on the other end.
 *
 * The relay is the real one from `relay/src` (in process, ephemeral port, memory store),
 * so this also checks the desktop against the relay's actual behaviour (protocol/SPEC.md §3.7).
 */

const encryptor: SecretEncryptor = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(text).reverse(),
  decrypt: (buf) => Buffer.from(buf).reverse().toString()
}

const PROJECTS: ProjectsData = {
  projects: [
    {
      id: 'p1', name: 'api-server', emoji: '🚀', directory: '/src/api',
      tasks: [createHomeTask('p1').task, {
        id: 't1', name: 'fix-auth',
        tabs: { left: [{ id: 'tab-chat', type: 'claude-chat', title: 'Claude' }, { id: 'tab-web', type: 'browser', title: 'Docs' }], right: [] },
        activeTab: { left: 'tab-chat', right: null }, splitOpen: false, splitRatio: 0.5
      }]
    },
    { id: 'p2', name: 'secret', directory: '/src/secret', hideFromMobile: true, tasks: [createHomeTask('p2').task] }
  ],
  tags: [],
  projectOrder: ['p1', 'p2'],
  pinnedItems: []
}

function inboxEvents(messages: AppMessage[]): InboxEvent[] {
  return messages.filter((m): m is InboxEvent => m.t === 'evt' && m.e === 'inbox')
}

describe('mobile end to end (real relay)', () => {
  let dir: string
  let store: MemoryStore
  let relay: RelayServer
  let service: MobileService
  let registry: TabActivityRegistry
  let states: MobileState[]
  let config: MobileConfig
  const phones: RelayPhone[] = []

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-mobile-e2e-'))
    store = new MemoryStore()
    relay = await startRelayServer({ store, port: 0, host: '127.0.0.1' })
    registry = new TabActivityRegistry()
    states = []
    config = { ...DEFAULT_MOBILE_CONFIG, relayUrl: relay.url }
    const identity = new IdentityStore(dir, encryptor)
    const listeners = new Set<() => void>()
    service = new MobileService({
      getConfig: () => config,
      saveConfig: (next) => { config = next },
      projects: { peek: () => PROJECTS, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } },
      activity: registry,
      pairings: new PairingsStore(dir),
      getDesktopId: () => identity.peekId(),
      defaultDesktopName: () => 'e2e-desktop',
      createTransport: () => new RelayClient({ ed25519: () => identity.get().ed25519, deviceId: () => identity.get().id }),
      channels: createNoiseChannelFactory({
        staticKey: () => identity.get().x25519,
        app: 'devtool/test',
        desktopName: () => 'e2e-desktop',
        log: () => {}
      }),
      createInvite: (options) => createInvite(identity.get(), options),
      broadcastState: (state) => states.push(state),
      log: () => {}
    })
    service.start()
  })

  afterEach(async () => {
    service.stop()
    for (const phone of phones.splice(0)) phone.close()
    await relay.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('pairs, serves the inbox, pushes a status change, resumes, and revokes', { timeout: 20_000 }, async () => {
    // Pairing turns Mobile on and connects.
    const invite = await service.startPairing()
    expect(config.enabled).toBe(true)
    await waitFor(() => service.getState().connection.kind === 'online', 'desktop online')

    // A phone scans the code: connects as pending, sends message 1 with the proof.
    const phone = new RelayPhone(invite.uri)
    phones.push(phone)
    await waitFor(() => service.getState().invite !== null, 'offer live')
    // The offer reaches the relay right after ready; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await phone.connect('pair')
    phone.phone.startHandshake(phone.phone.hello('pair', phone.secret))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello !== null, 'message 2')
    expect(phone.phone.desktopHello).toMatchObject({ result: 'pending', desktopName: 'e2e-desktop', app: 'devtool/test' })
    await waitFor(() => service.getState().pending !== null, 'pending request')
    expect(service.getState().pending).toMatchObject({ phoneId: phone.phone.id, name: 'Test iPhone' })
    expect(service.getState().invite).toBeNull()

    // The phone's socket blips before Accept. The relay keeps it pending (§3.7), the
    // desktop keeps the request, and the phone's pair handshake is answered `pending` again.
    phone.close()
    await waitFor(() => service.getState().pending?.online === false, 'pending phone offline')
    await phone.connect('pair')
    phone.phone.startHandshake(phone.phone.hello('pair', phone.secret))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello !== null, 'message 2 after reconnect')
    expect(phone.phone.desktopHello?.result).toBe('pending')
    await waitFor(() => service.getState().pending?.online === true, 'pending phone back')
    expect(phone.relayMessages.filter(m => m.t === 'error')).toEqual([])

    // Before Accept the phone gets nothing.
    phone.phone.request(1, 'inbox.get')
    phone.flush()
    await waitFor(() => phone.phone.messages.length === 1, 'not-authorized answer')
    expect(phone.phone.messages[0]).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'not-authorized' } })

    // Accept: stored, authorized at the relay, the phone hears about it and gets an inbox.
    service.accept(phone.phone.id)
    await waitFor(() => inboxEvents(phone.phone.messages).length === 1, 'first inbox event')
    expect(phone.phone.messages[1]).toEqual({ t: 'evt', e: 'pairing', status: 'accepted' })
    const first = inboxEvents(phone.phone.messages)[0]
    expect(first.seq).toBe(1)
    expect(first.inbox.desktop).toEqual({ id: phone.desktopId, name: 'e2e-desktop' })
    expect(first.inbox.projects.map(p => p.id)).toEqual(['p1'])
    expect(first.inbox.projects[0].tasks.map(t => t.id)).toEqual(['t1'])
    expect(first.inbox.projects[0].tasks[0].tabs).toEqual([{ id: 'tab-chat', type: 'claude-chat', title: 'Claude', status: 'idle' }])
    await waitFor(() => store.getPair(phone.desktopId, phone.phone.id) !== null, 'relay authorize')
    expect(service.getState().devices).toMatchObject([{ id: phone.phone.id, name: 'Test iPhone', online: true }])

    // inbox.get answers with the same picture.
    phone.phone.request(2, 'inbox.get')
    phone.phone.request(3, 'chat.send')
    phone.flush()
    await waitFor(() => phone.phone.messages.some(m => m.t === 'res' && m.id === 3), 'responses')
    const res = phone.phone.messages.find(m => m.t === 'res' && m.id === 2)
    expect(res).toMatchObject({ ok: true, result: { projects: [{ id: 'p1' }] } })
    expect(phone.phone.messages.find(m => m.t === 'res' && m.id === 3)).toMatchObject({ ok: false, error: { code: 'unsupported' } })

    // A hook moves the tab to working: a new inbox event follows (throttled, ≤ 1/s).
    registry.working('tab-chat')
    registry.applyHook('tab-chat', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await waitFor(() => inboxEvents(phone.phone.messages).some(e => e.inbox.projects[0].tasks[0].tabs[0].status === 'working'
      && e.inbox.projects[0].tasks[0].tabs[0].activity === 'Bash · npm test'), 'working inbox event', 4000)
    const seqs = inboxEvents(phone.phone.messages).map(e => e.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))

    // The phone reconnects and resumes with its stored keys.
    phone.close()
    await waitFor(() => service.getState().devices[0]?.online === false, 'phone offline')
    const before = phone.phone.messages.length
    await phone.connect('resume')
    phone.phone.startHandshake(phone.phone.hello('resume'))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello?.result === 'ok', 'resume ok')
    await waitFor(() => service.getState().devices[0]?.online === true, 'phone online again')
    phone.phone.request(4, 'inbox.get')
    phone.flush()
    await waitFor(() => phone.phone.messages.length > before, 'resumed inbox')
    expect(phone.phone.messages.at(-1)).toMatchObject({ t: 'res', id: 4, ok: true })

    // Revoke: the phone is told over the channel and by the relay.
    service.revoke(phone.phone.id)
    await waitFor(() => phone.relayMessages.some(m => m.t === 'peer' && m.state === 'revoked'), 'peer revoked')
    expect(phone.phone.messages.at(-1)).toEqual({ t: 'evt', e: 'pairing', status: 'revoked' })
    expect(store.phonesForDesktop(phone.desktopId)).toEqual([])
    expect(service.getState().devices).toEqual([])
  })

  it('a phone with the wrong proof is refused and the code stays usable', { timeout: 10_000 }, async () => {
    const invite = await service.startPairing()
    await waitFor(() => service.getState().connection.kind === 'online', 'desktop online')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const phone = new RelayPhone(invite.uri)
    phones.push(phone)
    await phone.connect('pair')
    phone.phone.startHandshake(phone.phone.hello('pair', new Uint8Array(32).fill(1)))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello !== null, 'message 2')
    expect(phone.phone.desktopHello?.result).toBe('rejected')
    expect(service.getState().pending).toBeNull()
    expect(service.getState().invite).not.toBeNull()
  })

  it('reconnects after the relay restarts, and re-sends the live offer', { timeout: 10_000 }, async () => {
    await service.startPairing()
    await waitFor(() => service.getState().connection.kind === 'online', 'desktop online')
    // Restart the relay on the same port: it closes every socket with 1001 and forgets offers.
    const port = relay.port
    await relay.close()
    await waitFor(() => service.getState().connection.kind !== 'online', 'desktop dropped')
    relay = await startRelayServer({ store, port, host: '127.0.0.1' })
    await waitFor(() => service.getState().connection.kind === 'online', 'desktop back', 5000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The re-sent offer is what lets a phone still attach with the same code.
    const phone = new RelayPhone(service.getState().invite!.uri)
    phones.push(phone)
    await phone.connect('pair')
    expect(phone.ready).toBe(true)
    // The real relay answers `ready` even to a stale token (§3.7), so prove the phone is
    // pending by completing the pair handshake through it.
    phone.phone.startHandshake(phone.phone.hello('pair', phone.secret))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello !== null, 'message 2')
    expect(phone.phone.desktopHello?.result).toBe('pending')
    expect(phone.relayMessages.filter(m => m.t === 'error')).toEqual([])
  })
})
