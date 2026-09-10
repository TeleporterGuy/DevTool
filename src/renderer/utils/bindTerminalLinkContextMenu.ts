import type { Terminal } from '@xterm/xterm'
import type { LinkMenuState } from '../components/LinkContextMenu'
import { findLinkAtPosition } from './terminalLinkAt'

export function bindTerminalLinkContextMenu(
  term: Terminal,
  onShowMenu: (menu: LinkMenuState) => void,
  onBackgroundContextMenu?: () => void
): { dispose(): void } {
  const element = term.element
  if (!element) return { dispose() {} }

  const handler = (e: MouseEvent) => {
    const url = findLinkAtPosition(term, e.clientX, e.clientY)
    if (url) {
      e.preventDefault()
      e.stopPropagation()
      onShowMenu({ url, x: e.clientX, y: e.clientY })
      return
    }
    // Windows terminals paste on right-click when the click is not on a link.
    if (onBackgroundContextMenu) {
      e.preventDefault()
      e.stopPropagation()
      onBackgroundContextMenu()
    }
  }

  element.addEventListener('contextmenu', handler)
  return {
    dispose() {
      element.removeEventListener('contextmenu', handler)
    }
  }
}
