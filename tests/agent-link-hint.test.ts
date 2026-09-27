// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SELECTION_HINT_DELAY_MS, attachAgentLinkHint } from '../src/renderer/agentLink/selectionHint'

type Sel = {
  startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number
  positionLineNumber: number; positionColumn: number; selectionStartLineNumber: number
}

function fakeEditor() {
  let selectionCb: () => void = () => {}
  let blurCb: () => void = () => {}
  let disposeCb: () => void = () => {}
  const widgets = new Set<{ getDomNode(): HTMLElement }>()
  const state = { selection: null as Sel | null, focused: true }
  const ed = {
    getSelection: () => state.selection,
    hasTextFocus: () => state.focused,
    onDidChangeCursorSelection: (cb: () => void) => { selectionCb = cb; return { dispose: () => {} } },
    onDidBlurEditorWidget: (cb: () => void) => { blurCb = cb; return { dispose: () => {} } },
    onDidDispose: (cb: () => void) => { disposeCb = cb; return { dispose: () => {} } },
    addContentWidget: (w: { getDomNode(): HTMLElement }) => { widgets.add(w) },
    removeContentWidget: (w: { getDomNode(): HTMLElement }) => { widgets.delete(w) },
    layoutContentWidget: () => {}
  }
  const select = (sel: Sel | null) => {
    state.selection = sel
    selectionCb()
  }
  return { ed: ed as any, state, widgets, select, blur: () => blurCb(), dispose: () => disposeCb() }
}

const range: Sel = { startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 3, positionLineNumber: 4, positionColumn: 3, selectionStartLineNumber: 2 }
const caret: Sel = { startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 2, positionLineNumber: 3, positionColumn: 2, selectionStartLineNumber: 3 }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('agent link selection hint', () => {
  it('shows after the selection settles, with the shortcut in it', () => {
    const f = fakeEditor()
    attachAgentLinkHint(f.ed, { enabled: () => true, onLink: () => {} })
    f.select(range)
    expect(f.widgets.size).toBe(0)
    vi.advanceTimersByTime(SELECTION_HINT_DELAY_MS)
    expect(f.widgets.size).toBe(1)
    expect([...f.widgets][0].getDomNode().textContent).toMatch(/Add to agent/)
    expect([...f.widgets][0].getDomNode().textContent).toMatch(/L$/)
  })

  it('stays hidden without an agent tab, an empty selection, or focus', () => {
    const noAgent = fakeEditor()
    attachAgentLinkHint(noAgent.ed, { enabled: () => false, onLink: () => {} })
    noAgent.select(range)
    vi.advanceTimersByTime(SELECTION_HINT_DELAY_MS)
    expect(noAgent.widgets.size).toBe(0)

    const empty = fakeEditor()
    attachAgentLinkHint(empty.ed, { enabled: () => true, onLink: () => {} })
    empty.select(caret)
    vi.advanceTimersByTime(SELECTION_HINT_DELAY_MS)
    expect(empty.widgets.size).toBe(0)

    const unfocused = fakeEditor()
    unfocused.state.focused = false
    attachAgentLinkHint(unfocused.ed, { enabled: () => true, onLink: () => {} })
    unfocused.select(range)
    vi.advanceTimersByTime(SELECTION_HINT_DELAY_MS)
    expect(unfocused.widgets.size).toBe(0)
  })

  it('hides when the selection is cleared, on blur, and on dispose', () => {
    const f = fakeEditor()
    attachAgentLinkHint(f.ed, { enabled: () => true, onLink: () => {} })
    f.select(range)
    vi.advanceTimersByTime(SELECTION_HINT_DELAY_MS)
    f.select(caret)
    expect(f.widgets.size).toBe(0)

    f.select(range)
    vi.advanceTimersByTime(SELECTION_HINT_DELAY_MS)
    f.blur()
    expect(f.widgets.size).toBe(0)

    f.select(range)
    vi.advanceTimersByTime(SELECTION_HINT_DELAY_MS)
    f.dispose()
    expect(f.widgets.size).toBe(0)
  })

  it('links on click and keeps the editor focused on mousedown', () => {
    const f = fakeEditor()
    const onLink = vi.fn()
    attachAgentLinkHint(f.ed, { enabled: () => true, onLink })
    f.select(range)
    vi.advanceTimersByTime(SELECTION_HINT_DELAY_MS)
    const node = [...f.widgets][0].getDomNode()

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    node.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)

    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onLink).toHaveBeenCalledTimes(1)
    expect(f.widgets.size).toBe(0)
  })
})
