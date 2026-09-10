import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleTerminalPasteKey,
  isTerminalPasteKey,
  pasteIntoTerminal,
  readClipboardText
} from '../src/renderer/components/terminalPaste'

function key(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    type: 'keydown',
    key: 'a',
    ...partial
  } as KeyboardEvent
}

describe('terminalPaste', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats Ctrl+V, Ctrl+Shift+V, Cmd+V, and Shift+Insert as paste', () => {
    expect(isTerminalPasteKey(key({ key: 'v', ctrlKey: true }))).toBe(true)
    expect(isTerminalPasteKey(key({ key: 'v', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isTerminalPasteKey(key({ key: 'v', metaKey: true }))).toBe(true)
    expect(isTerminalPasteKey(key({ key: 'Insert', shiftKey: true }))).toBe(true)
  })

  it('does not steal Ctrl+C or a bare v', () => {
    expect(isTerminalPasteKey(key({ key: 'c', ctrlKey: true }))).toBe(false)
    expect(isTerminalPasteKey(key({ key: 'v' }))).toBe(false)
    expect(isTerminalPasteKey(key({ key: 'v', altKey: true, ctrlKey: true }))).toBe(false)
  })

  it('reads via the Electron clipboard bridge', async () => {
    const clipboardReadText = vi.fn().mockResolvedValue('from-os')
    vi.stubGlobal('window', { api: { clipboardReadText } })
    await expect(readClipboardText()).resolves.toBe('from-os')
    expect(clipboardReadText).toHaveBeenCalled()
  })

  it('swallows Ctrl+V without calling term.paste (Electron Edit menu already pastes)', () => {
    const clipboardReadText = vi.fn().mockResolvedValue('hello')
    vi.stubGlobal('window', { api: { clipboardReadText } })
    const term = { paste: vi.fn() }

    expect(handleTerminalPasteKey(key({ key: 'v', ctrlKey: true }), term)).toBe(false)
    expect(term.paste).not.toHaveBeenCalled()
    expect(clipboardReadText).not.toHaveBeenCalled()
  })

  it('pastes on Shift+Insert, which has no Edit menu accelerator', async () => {
    const clipboardReadText = vi.fn().mockResolvedValue('hello')
    vi.stubGlobal('window', { api: { clipboardReadText } })
    const term = { paste: vi.fn() }

    expect(handleTerminalPasteKey(key({ key: 'Insert', shiftKey: true }), term)).toBe(false)
    await vi.waitFor(() => expect(term.paste).toHaveBeenCalledWith('hello'))
  })

  it('skips empty clipboard text', () => {
    const term = { paste: vi.fn() }
    pasteIntoTerminal(term, '')
    expect(term.paste).not.toHaveBeenCalled()
  })
})
