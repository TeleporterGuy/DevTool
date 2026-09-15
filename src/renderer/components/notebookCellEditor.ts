import type { NotebookCellType } from '../../shared/notebook'

/**
 * Only the focused, expanded cell mounts Monaco.
 * Inactive cells render a read-only <pre> (or markdown preview), so a reorder
 * never moves two live editor hosts in the DOM — that swap was crashing the renderer.
 */
export function notebookCellMountsMonaco(args: {
  isActive: boolean
  collapsed: boolean
  cellType: NotebookCellType
  isEditingMarkdown: boolean
}): boolean {
  if (!args.isActive || args.collapsed) return false
  if (args.cellType === 'markdown' && !args.isEditingMarkdown) return false
  return true
}
