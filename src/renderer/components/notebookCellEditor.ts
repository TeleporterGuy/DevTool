import type { NotebookCellType } from '../../shared/notebook'

/**
 * Only the focused, expanded cell mounts Monaco (the edit surface).
 * Idle code cells are a highlight.js read-only preview — they must look like
 * code, not markdown prose. That is intentional: many live Monaco hosts plus
 * a DOM reorder crashed monaco-react ("InstantiationService has been disposed").
 *
 * During reorder, NotebookTab sets suspendEditors and flushSync-unmounts every
 * <Editor> *before* moveCellById splices the list, then remounts.
 *
 * Move sequence (NotebookTab):
 *   1. suspendEditors = true (this helper returns false for every cell)
 *   2. flushSync so the unmount commits
 *   3. markDirty(moveCellById(...))
 *   4. double rAF, then suspendEditors = false and restore activeCellId
 */
export function notebookCellMountsMonaco(args: {
  isActive: boolean
  collapsed: boolean
  cellType: NotebookCellType
  isEditingMarkdown: boolean
  suspendEditors?: boolean
}): boolean {
  if (args.suspendEditors) return false
  if (!args.isActive || args.collapsed) return false
  if (args.cellType === 'markdown' && !args.isEditingMarkdown) return false
  return true
}

/** Double rAF: paint the editor-less reordered tree, then remount Monaco once. */
export function scheduleResumeAfterNotebookReorder(resume: () => void): () => void {
  let innerId = 0
  const outerId = requestAnimationFrame(() => {
    innerId = requestAnimationFrame(resume)
  })
  return () => {
    cancelAnimationFrame(outerId)
    cancelAnimationFrame(innerId)
  }
}
