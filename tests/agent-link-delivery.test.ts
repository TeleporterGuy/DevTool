// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_READY_TIMEOUT_MS,
  agentTerminalReady,
  onAgentInsert,
  queueAgentInsert,
  resolveAgentLinkRoute
} from '../src/renderer/agentLink/linkToAgent'
import { getAgentRecency, noteAgentTabTyped } from '../src/renderer/agentLink/agentTabRecency'
import { commandRegistry } from '../src/renderer/palette/CommandRegistry'
import { paletteEvents, setPaletteReturnFocus } from '../src/renderer/palette/paletteEvents'
import '../src/renderer/palette/sources/commands'
import type { Tab } from '../src/shared/types'

const tab = (id: string, type: Tab['type']): Tab => ({ id, type, title: id })

describe('agent insert queue', () => {
  it('holds links for a tab that has not mounted yet and hands them over on subscribe', () => {
    queueAgentInsert('later', 'one ')
    queueAgentInsert('later', 'two ')
    const got: string[] = []
    const off = onAgentInsert('later', text => got.push(text))
    expect(got).toEqual(['one ', 'two '])
    queueAgentInsert('later', 'three ')
    expect(got).toEqual(['one ', 'two ', 'three '])
    off()
  })

  it('queues again once the tab unsubscribes (e.g. unmounted by closing the split)', () => {
    const got: string[] = []
    const off = onAgentInsert('split', text => got.push(text))
    off()
    queueAgentInsert('split', 'while gone ')
    expect(got).toEqual([])
    const again: string[] = []
    const off2 = onAgentInsert('split', text => again.push(text))
    expect(again).toEqual(['while gone '])
    off2()
  })

  it('an old unsubscribe does not remove the newer receiver', () => {
    const first: string[] = []
    const second: string[] = []
    const offFirst = onAgentInsert('remount', text => first.push(text))
    const offSecond = onAgentInsert('remount', text => second.push(text))
    offFirst()
    queueAgentInsert('remount', 'x ')
    expect(second).toEqual(['x '])
    expect(first).toEqual([])
    offSecond()
  })

  it('drops queued links for a removed tab', () => {
    queueAgentInsert('closed', 'lost ')
    window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: 'closed' } }))
    const got: string[] = []
    const off = onAgentInsert('closed', text => got.push(text))
    expect(got).toEqual([])
    off()
  })
})

describe('resolveAgentLinkRoute', () => {
  const task = {
    tabs: { left: [tab('ed', 'editor')], right: [tab('claude', 'claude')] }
  }

  it('opens a closed split when the agent lives in the right pane', () => {
    const route = resolveAgentLinkRoute(task, { activeTab: { left: 'ed', right: 'claude' }, splitOpen: false }, [])
    expect(route).toMatchObject({ pane: 'right', openSplit: true })
    expect(route?.tab.id).toBe('claude')
  })

  it('leaves an open split alone', () => {
    const route = resolveAgentLinkRoute(task, { activeTab: { left: 'ed', right: 'claude' }, splitOpen: true }, [])
    expect(route?.openSplit).toBe(false)
  })

  it('never opens the split for a left-pane agent', () => {
    const left = { tabs: { left: [tab('ed', 'editor'), tab('pi', 'pi')], right: [] } }
    const route = resolveAgentLinkRoute(left, { activeTab: { left: 'ed', right: null }, splitOpen: false }, [])
    expect(route).toMatchObject({ pane: 'left', openSplit: false })
  })

  it('returns null without an agent tab', () => {
    const none = { tabs: { left: [tab('ed', 'editor')], right: [] } }
    expect(resolveAgentLinkRoute(none, { activeTab: { left: 'ed', right: null }, splitOpen: false }, [])).toBeNull()
  })
})

describe('agent recency', () => {
  it('puts the tab typed in last first, per task', () => {
    noteAgentTabTyped('task-r', 'a')
    noteAgentTabTyped('task-r', 'b')
    noteAgentTabTyped('task-r', 'a')
    noteAgentTabTyped('task-other', 'c')
    expect(getAgentRecency('task-r')).toEqual(['a', 'b'])
    expect(getAgentRecency('task-other')).toEqual(['c'])
  })

  it('forgets removed tabs', () => {
    noteAgentTabTyped('task-f', 'gone')
    noteAgentTabTyped('task-f', 'kept')
    window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: 'gone' } }))
    expect(getAgentRecency('task-f')).toEqual(['kept'])
  })
})

describe('agentTerminalReady', () => {
  const base = { attachedAt: 1000, restoring: false, bracketedPaste: true, now: 1100 }

  it('waits for the PTY to be attached', () => {
    expect(agentTerminalReady({ ...base, attachedAt: null })).toBe(false)
  })

  it('waits while scrollback replays', () => {
    expect(agentTerminalReady({ ...base, restoring: true })).toBe(false)
  })

  it('waits for the TUI to turn on bracketed paste', () => {
    expect(agentTerminalReady({ ...base, bracketedPaste: false })).toBe(false)
    expect(agentTerminalReady(base)).toBe(true)
  })

  it('gives up waiting for bracketed paste after the timeout', () => {
    expect(agentTerminalReady({ ...base, bracketedPaste: false, now: 1000 + AGENT_READY_TIMEOUT_MS })).toBe(true)
  })
})

describe('palette Link to Agent commands', () => {
  afterEach(() => setPaletteReturnFocus(null))

  it('hands the tab that had focus the request, and shows no notice when it answers', () => {
    const editorEl = document.createElement('div')
    setPaletteReturnFocus(editorEl)
    const notices: string[] = []
    const offNotice = paletteEvents.on('agent-link-notice', m => notices.push(m))
    const offLink = paletteEvents.on('link-to-agent', request => {
      if (request.target === editorEl) request.handled = true
    })
    void commandRegistry.getById('cmd.linkSelectionToAgent')!.run({ actions: {} as any })
    expect(notices).toEqual([])
    offLink()
    offNotice()
  })

  it('says so when no editor or notebook had focus', () => {
    setPaletteReturnFocus(document.createElement('div'))
    const notices: string[] = []
    const offNotice = paletteEvents.on('agent-link-notice', m => notices.push(m))
    void commandRegistry.getById('cmd.linkFileToAgent')!.run({ actions: {} as any })
    expect(notices).toHaveLength(1)
    offNotice()
  })
})
