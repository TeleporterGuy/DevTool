import { describe, expect, it } from 'vitest'
import { notebookCellMountsMonaco } from '../src/renderer/components/notebookCellEditor'

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
})
