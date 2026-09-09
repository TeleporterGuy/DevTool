import { describe, expect, it } from 'vitest'
import { commandRegistry } from '../src/renderer/palette/CommandRegistry'
import '../src/renderer/palette/sources/commands'
import { formatShortcut } from '../src/shared/shortcut-label'

describe('palette menu shortcut labels', () => {
  it('stores Electron accelerators for commands that already have a menu key', () => {
    expect(commandRegistry.getById('cmd.newTerminalTab')?.shortcut).toBe('CmdOrCtrl+T')
    expect(commandRegistry.getById('cmd.toggleSidebar')?.shortcut).toBe('CmdOrCtrl+B')
    expect(commandRegistry.getById('cmd.toggleFileBrowser')?.shortcut).toBe('CmdOrCtrl+Shift+E')
    expect(commandRegistry.getById('cmd.openDevTools')?.shortcut).toBe('CmdOrCtrl+Alt+I')
  })

  it('hides Open Settings shortcut off macOS so the row does not claim Ctrl+,', () => {
    const stored = commandRegistry.getById('cmd.openSettings')?.shortcut
    if (process.platform === 'darwin') {
      expect(stored).toBe('Command+,')
      expect(formatShortcut(stored!, 'darwin')).toBe('⌘,')
    } else {
      expect(stored).toBeUndefined()
    }
  })

  it('formats stored accelerators to Windows plus-separated labels', () => {
    expect(formatShortcut('CmdOrCtrl+T', 'win32')).toBe('Ctrl+T')
    expect(formatShortcut('CmdOrCtrl+B', 'win32')).toBe('Ctrl+B')
    expect(formatShortcut('CmdOrCtrl+Shift+E', 'win32')).toBe('Ctrl+Shift+E')
    expect(formatShortcut('CmdOrCtrl+Alt+I', 'win32')).toBe('Ctrl+Alt+I')
  })
})
