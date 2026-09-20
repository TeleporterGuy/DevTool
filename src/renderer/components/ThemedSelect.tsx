import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useMenuPosition, type MenuAnchor } from '../hooks/useMenuPosition'

export interface ThemedSelectOption {
  value: string
  label: string
}

interface Props {
  value: string
  options: ThemedSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  'aria-label': string
  title?: string
  /** Optional status dot (notebook kernel picker). */
  leading?: React.ReactNode
  className?: string
  /** sm = notebook toolbar; md = form field. */
  size?: 'sm' | 'md'
}

/**
 * App-themed dropdown. Native select option lists on Windows Chromium
 * ignore CSS and paint as a bright OS popup.
 */
export default function ThemedSelect({
  value,
  options,
  onChange,
  disabled = false,
  'aria-label': ariaLabel,
  title,
  leading,
  className,
  size = 'md'
}: Props): React.ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const [menuWidth, setMenuWidth] = useState<number | undefined>(undefined)
  const open = anchor != null
  const menuPos = useMenuPosition<HTMLDivElement>(anchor)
  const selected = options.find((option) => option.value === value)
  const label = selected?.label ?? options[0]?.label ?? ''

  const close = () => setAnchor(null)

  const toggle = () => {
    if (disabled) return
    if (open) {
      close()
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuWidth(Math.max(rect.width, 160))
    setAnchor({ x: rect.left, y: rect.bottom + 4 })
  }

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const compact = size === 'sm'
  const triggerCls = compact
    ? 'h-(--ctl-h-sm) text-2xs pl-1.5 pr-1 gap-1'
    : 'h-(--ctl-h) text-base px-2.5 gap-1.5'

  return (
    <div className={`relative min-w-0 ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        className={
          `inline-flex items-center w-full min-w-0 rounded-md bg-field border border-border ` +
          `text-text cursor-pointer outline-none focus:border-border-focus ` +
          `disabled:opacity-40 disabled:cursor-default ${triggerCls}`
        }
        onClick={toggle}
      >
        {leading}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronDown size={compact ? 12 : 14} className="shrink-0 text-text-muted" aria-hidden />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-(--z-popover)" onClick={close} />
          <div
            ref={menuPos.ref}
            role="listbox"
            aria-label={ariaLabel}
            style={{ ...menuPos.style, minWidth: menuWidth }}
            className="fixed z-(--z-popover) max-h-60 overflow-y-auto bg-surface border-[0.5px] border-border rounded-lg p-1 shadow-pop text-text"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {options.map((option) => {
              const isSelected = option.value === value
              return (
                <button
                  key={option.value === '' ? '__empty' : option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={
                    `block w-full rounded-md px-2.5 py-1 border-0 text-left cursor-pointer hover:bg-sel ` +
                    `${compact ? 'text-2xs' : 'text-base'} ` +
                    `${isSelected ? 'bg-sel text-text' : 'bg-transparent text-text'}`
                  }
                  onClick={() => {
                    close()
                    if (option.value !== value) onChange(option.value)
                  }}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
