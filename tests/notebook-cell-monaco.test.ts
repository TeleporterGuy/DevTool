import { describe, expect, it, vi } from 'vitest'
import {
  notebookCellMountsMonaco,
  scheduleResumeAfterNotebookReorder
} from '../src/renderer/components/notebookCellEditor'

describe('notebookCellMountsMonaco', () => {
  it('mounts Monaco only for the active expanded cell (not markdown preview)', () => {
    expect(notebookCellMountsMonaco({
      isActive: true,
      collapsed: false,
      cellType: 'code',
      isEditingMarkdown: false
    })).toBe(true)
    expect(notebookCellMountsMonaco({
      isActive: true,
      collapsed: false,
      cellType: 'raw',
      isEditingMarkdown: false
    })).toBe(true)
    expect(notebookCellMountsMonaco({
      isActive: true,
      collapsed: false,
      cellType: 'markdown',
      isEditingMarkdown: true
    })).toBe(true)

    // Inactive cells stay as <pre> so a reorder never swaps two Monaco hosts.
    expect(notebookCellMountsMonaco({
      isActive: false,
      collapsed: false,
      cellType: 'code',
      isEditingMarkdown: false
    })).toBe(false)
    expect(notebookCellMountsMonaco({
      isActive: true,
      collapsed: true,
      cellType: 'code',
      isEditingMarkdown: false
    })).toBe(false)
    expect(notebookCellMountsMonaco({
      isActive: true,
      collapsed: false,
      cellType: 'markdown',
      isEditingMarkdown: false
    })).toBe(false)
  })

  it('never mounts Monaco while editors are suspended for a cell reorder', () => {
    expect(notebookCellMountsMonaco({
      isActive: true,
      collapsed: false,
      cellType: 'code',
      isEditingMarkdown: false,
      suspendEditors: true
    })).toBe(false)
    expect(notebookCellMountsMonaco({
      isActive: true,
      collapsed: false,
      cellType: 'markdown',
      isEditingMarkdown: true,
      suspendEditors: true
    })).toBe(false)
  })
})

describe('scheduleResumeAfterNotebookReorder', () => {
  it('runs resume after two animation frames', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const resume = vi.fn()
    scheduleResumeAfterNotebookReorder(resume)
    expect(resume).not.toHaveBeenCalled()
    frames[0]?.(0)
    expect(resume).not.toHaveBeenCalled()
    frames[1]?.(0)
    expect(resume).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
