import type { TabType } from '../../shared/types'
import { DEFAULT_CONFIG } from '../../shared/types'
import { EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN } from './monacoOptions'

export type ZoomTarget = 'terminal' | 'browser' | 'editor'

/**
 * Menu Ctrl+=/−/0 follows the focused tab: browser page zoom, Monaco editor
 * font, or terminal zoom delta. Notes and diffs share the editor font.
 */
export function zoomTargetForTabType(tabType: TabType | null | undefined): ZoomTarget {
  if (tabType === 'browser') return 'browser'
  if (
    tabType === 'editor' ||
    tabType === 'notebook' ||
    tabType === 'note' ||
    tabType === 'diff'
  ) {
    return 'editor'
  }
  return 'terminal'
}

export function nextEditorFontSize(
  current: number,
  direction: 'in' | 'out' | 'reset'
): number {
  if (direction === 'reset') return DEFAULT_CONFIG.editorFontSize
  const base = Number.isFinite(current) ? current : DEFAULT_CONFIG.editorFontSize
  const delta = direction === 'in' ? 1 : -1
  return Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, base + delta))
}
