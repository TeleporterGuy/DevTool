import type { editor } from 'monaco-editor'
import { formatShortcutForApp } from '../../shared/shortcut-label'

/** Wait this long after the selection settles before showing the hint (not mid-drag). */
export const SELECTION_HINT_DELAY_MS = 350

// Monaco ContentWidgetPositionPreference; numbers, like the KeyMod/KeyCode values
// elsewhere, so this does not pull the monaco runtime into the renderer bundle.
const ABOVE = 1
const BELOW = 2

type HintEditor = Pick<
  editor.IStandaloneCodeEditor,
  | 'getSelection'
  | 'hasTextFocus'
  | 'onDidChangeCursorSelection'
  | 'onDidBlurEditorWidget'
  | 'onDidDispose'
  | 'addContentWidget'
  | 'removeContentWidget'
  | 'layoutContentWidget'
>

/**
 * A small "Add to agent Ctrl+L" chip at the end of a non-empty selection, so the
 * shortcut is discoverable. Shown only while `enabled()` (the task has an agent
 * tab), the selection is not empty and the editor has focus; clicking it links
 * like the shortcut. Cleans up with the editor.
 */
export function attachAgentLinkHint(
  ed: HintEditor,
  options: { enabled: () => boolean; onLink: () => void; label?: string }
): { dispose(): void } {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = 'devtool-agent-link-hint'
  node.textContent = `${options.label ?? 'Add to agent'}  ${formatShortcutForApp('CmdOrCtrl+L')}`
  node.title = 'Link the selection to this task’s agent'
  Object.assign(node.style, {
    padding: '1px 6px',
    fontSize: '11px',
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    borderRadius: '4px',
    border: '0.5px solid var(--color-border)',
    background: 'var(--color-surface-2)',
    color: 'var(--color-text-muted)',
    boxShadow: 'var(--shadow-pop)',
    cursor: 'pointer',
    zIndex: '10'
  })

  let shown = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const widget: editor.IContentWidget = {
    allowEditorOverflow: true,
    getId: () => 'devtool.agentLinkHint',
    getDomNode: () => node,
    getPosition: () => {
      const sel = ed.getSelection()
      if (!sel) return null
      return {
        position: { lineNumber: sel.positionLineNumber, column: sel.positionColumn },
        preference: sel.positionLineNumber < sel.selectionStartLineNumber ? [ABOVE, BELOW] : [BELOW, ABOVE]
      }
    }
  }

  const hide = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (shown) {
      ed.removeContentWidget(widget)
      shown = false
    }
  }

  const selectionIsEmpty = (): boolean => {
    const sel = ed.getSelection()
    return !sel || (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn)
  }

  const update = (): void => {
    if (selectionIsEmpty() || !ed.hasTextFocus() || !options.enabled()) {
      hide()
      return
    }
    if (shown) ed.layoutContentWidget(widget)
    else {
      ed.addContentWidget(widget)
      shown = true
    }
  }

  // Keep the editor's focus and selection when the chip is pressed.
  node.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  node.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    hide()
    options.onLink()
  })

  const subs = [
    ed.onDidChangeCursorSelection(() => {
      if (shown && selectionIsEmpty()) {
        hide()
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        update()
      }, SELECTION_HINT_DELAY_MS)
    }),
    ed.onDidBlurEditorWidget(hide)
  ]

  const dispose = (): void => {
    hide()
    for (const sub of subs) sub.dispose()
  }
  ed.onDidDispose(dispose)
  return { dispose }
}
