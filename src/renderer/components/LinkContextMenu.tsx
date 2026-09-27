import React from 'react'
import { normalizeBrowserUrl } from '../browserUrl'
import { useMenuPosition } from '../hooks/useMenuPosition'
import { menuCls, menuItemCls } from './ui/menu'

export interface LinkMenuState {
  /** The link under the pointer; the link rows appear only when set. */
  url?: string
  /** Selected text to offer a Copy row for. */
  selection?: string
  x: number
  y: number
}

interface Props {
  menu: LinkMenuState | null
  onClose: () => void
  onOpenInApp: (url: string) => void
}

export default function LinkContextMenu({ menu, onClose, onOpenInApp }: Props): React.ReactElement | null {
  const menuPos = useMenuPosition<HTMLDivElement>(menu)

  if (!menu) return null

  const normalized = menu.url ? normalizeBrowserUrl(menu.url) : null
  const run = (action: () => void) => () => {
    action()
    onClose()
  }

  return (
    <>
      <div
        className="fixed inset-0 z-(--z-menu)"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          // Keep a parent's own context-menu handler from reopening the menu.
          e.stopPropagation()
          onClose()
        }}
      />
      <div
        ref={menuPos.ref}
        style={menuPos.style}
        role="menu"
        className={`fixed z-(--z-menu) min-w-[180px] ${menuCls}`}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {menu.selection && (
          <button type="button" role="menuitem" className={menuItemCls}
            onClick={run(() => void window.api.clipboardWriteText(menu.selection!))}
          >
            Copy
          </button>
        )}
        {menu.selection && normalized && <div className="my-1 border-t border-hair" />}
        {normalized && (
          <>
            <button type="button" role="menuitem" className={menuItemCls} onClick={run(() => onOpenInApp(normalized))}>
              Open in Browser Tab
            </button>
            <button type="button" role="menuitem" className={menuItemCls}
              onClick={run(() => void window.api.clipboardWriteText(normalized))}
            >
              Copy Link
            </button>
            <button type="button" role="menuitem" className={menuItemCls}
              onClick={run(() => void window.api.openExternal(normalized))}
            >
              Open in System Browser
            </button>
          </>
        )}
      </div>
    </>
  )
}
