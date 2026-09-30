import React, { useEffect } from 'react'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'
import { menuCls, menuItemCls } from './menu'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

/**
 * A right-click menu at the pointer, kept inside the window. Any click outside,
 * another right-click or Escape closes it; picking an item closes it first.
 */
export default function ContextMenu({ menu, items, onClose }: {
  menu: MenuAnchor | null
  items: ContextMenuItem[]
  onClose: () => void
}): React.ReactElement | null {
  const position = useMenuPosition<HTMLDivElement>(menu)

  useEffect(() => {
    if (!menu) return
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menu, onClose])

  if (!menu) return null
  return (
    <>
      <div
        className="fixed inset-0 z-(--z-menu)"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div ref={position.ref} role="menu" className={`fixed z-(--z-menu) ${menuCls}`} style={position.style}>
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`${menuItemCls}${item.danger ? ' text-danger' : ''} disabled:opacity-50 disabled:cursor-default`}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  )
}
