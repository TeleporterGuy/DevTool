import { describe, expect, it } from 'vitest'
import { formatShortcut } from '../src/shared/shortcut-label'

describe('formatShortcut', () => {
  it('maps CmdOrCtrl to ⌘ on macOS and Ctrl on Windows', () => {
    expect(formatShortcut('CmdOrCtrl+W', 'darwin')).toBe('⌘W')
    expect(formatShortcut('CmdOrCtrl+W', 'win32')).toBe('Ctrl+W')
    expect(formatShortcut('CmdOrCtrl+W', 'linux')).toBe('Ctrl+W')
  })

  it('keeps Shift as a chord', () => {
    expect(formatShortcut('CmdOrCtrl+Shift+T', 'darwin')).toBe('⌘⇧T')
    expect(formatShortcut('CmdOrCtrl+Shift+T', 'win32')).toBe('Ctrl+Shift+T')
    expect(formatShortcut('CmdOrCtrl+Shift+V', 'darwin')).toBe('⌘⇧V')
    expect(formatShortcut('CmdOrCtrl+Shift+V', 'win32')).toBe('Ctrl+Shift+V')
  })

  it('maps Alt / Option to ⌥ or Alt', () => {
    expect(formatShortcut('CmdOrCtrl+Alt+I', 'darwin')).toBe('⌘⌥I')
    expect(formatShortcut('CmdOrCtrl+Alt+I', 'win32')).toBe('Ctrl+Alt+I')
  })

  it('formats the Mac-only Settings key', () => {
    expect(formatShortcut('Command+,', 'darwin')).toBe('⌘,')
    expect(formatShortcut('Command+,', 'win32')).toBe('Ctrl+,')
  })

  it('formats tab-number overlays', () => {
    expect(formatShortcut('CmdOrCtrl+1', 'darwin')).toBe('⌘1')
    expect(formatShortcut('CmdOrCtrl+1', 'win32')).toBe('Ctrl+1')
    expect(formatShortcut('CmdOrCtrl+Shift+1', 'darwin')).toBe('⌘⇧1')
    expect(formatShortcut('CmdOrCtrl+Shift+1', 'win32')).toBe('Ctrl+Shift+1')
  })

  it('leaves zoom keys readable', () => {
    expect(formatShortcut('CmdOrCtrl+=', 'win32')).toBe('Ctrl+=')
    expect(formatShortcut('CmdOrCtrl+-', 'win32')).toBe('Ctrl+-')
    expect(formatShortcut('CmdOrCtrl+0', 'darwin')).toBe('⌘0')
  })
})
