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

  it('treats Ctrl+V, Ctrl+Shift+V and Shift+Insert as paste on Windows/Linux', () => {
    expect(isTerminalPasteKey(key({ key: 'v', ctrlKey: true }), 'win32')).toBe(true)
    expect(isTerminalPasteKey(key({ key: 'v', ctrlKey: true, shiftKey: true }), 'linux')).toBe(true)
    expect(isTerminalPasteKey(key({ key: 'Insert', shiftKey: true }), 'win32')).toBe(true)
  })

  it('on macOS only Cmd+V and Shift+Insert paste; Ctrl+V reaches the PTY', () => {
    expect(isTerminalPasteKey(key({ key: 'v', metaKey: true }), 'darwin')).toBe(true)
    expect(isTerminalPasteKey(key({ key: 'Insert', shiftKey: true }), 'darwin')).toBe(true)
    expect(isTerminalPasteKey(key({ key: 'v', ctrlKey: true }), 'darwin')).toBe(false)
    expect(isTerminalPasteKey(key({ key: 'v', ctrlKey: true, shiftKey: true }), 'darwin')).toBe(false)
  })

  it('does not steal Ctrl+C or a bare v', () => {
    expect(isTerminalPasteKey(key({ key: 'c', ctrlKey: true }), 'win32')).toBe(false)
    expect(isTerminalPasteKey(key({ key: 'v' }), 'win32')).toBe(false)
    expect(isTerminalPasteKey(key({ key: 'v', altKey: true, ctrlKey: true }), 'win32')).toBe(false)
  })

  it('lets Ctrl+V through to the shell on macOS (vim visual block, quoted-insert)', () => {
    const term = { paste: vi.fn() }
    expect(handleTerminalPasteKey(key({ key: 'v', ctrlKey: true }), term, 'darwin')).toBe(true)
    expect(term.paste).not.toHaveBeenCalled()
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

    expect(handleTerminalPasteKey(key({ key: 'v', ctrlKey: true }), term, 'win32')).toBe(false)
    expect(handleTerminalPasteKey(key({ key: 'v', metaKey: true }), term, 'darwin')).toBe(false)
    expect(term.paste).not.toHaveBeenCalled()
    expect(clipboardReadText).not.toHaveBeenCalled()
  })

  it('pastes on Shift+Insert, which has no Edit menu accelerator', async () => {
    const clipboardReadText = vi.fn().mockResolvedValue('hello')
    vi.stubGlobal('window', { api: { clipboardReadText } })
    const term = { paste: vi.fn() }

    expect(handleTerminalPasteKey(key({ key: 'Insert', shiftKey: true }), term, 'darwin')).toBe(false)
    await vi.waitFor(() => expect(term.paste).toHaveBeenCalledWith('hello'))
  })

  it('skips empty clipboard text', () => {
    const term = { paste: vi.fn() }
    pasteIntoTerminal(term, '')
    expect(term.paste).not.toHaveBeenCalled()
  })
})
