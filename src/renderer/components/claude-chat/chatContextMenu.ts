import type { LinkMenuState } from '../LinkContextMenu'

/**
 * The menu for a right-click in the chat, or null to leave the click alone.
 * Offers the http(s) link under the pointer (the only links a left click opens)
 * and the current selection when it lies inside the chat. Text fields keep
 * their own editing behaviour.
 */
export function chatContextMenuAt(
  target: Element,
  container: Element,
  selection: Selection | null,
  x: number,
  y: number
): LinkMenuState | null {
  if (target.closest('textarea, input, [contenteditable="true"]')) return null
  const href = target.closest('a')?.getAttribute('href') ?? ''
  const url = /^https?:\/\//i.test(href) ? href : undefined
  const text = selection && !selection.isCollapsed && selection.anchorNode && container.contains(selection.anchorNode)
    ? selection.toString()
    : ''
  const selected = text.trim() ? text : undefined
  if (!url && !selected) return null
  return { url, selection: selected, x, y }
}
