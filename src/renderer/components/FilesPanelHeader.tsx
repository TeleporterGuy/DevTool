import React from 'react'
import { ChevronsDownUp, ChevronsUpDown, FilePlus, FolderPlus } from 'lucide-react'
import { Field } from './ui'

const iconBtnCls =
  'flex items-center justify-center size-7 shrink-0 rounded-md bg-transparent border-0 text-text-muted hover:text-text hover:bg-surface-3 cursor-pointer'

interface Props {
  filterQuery: string
  onFilterChange: (value: string) => void
  onNewFile: () => void
  onNewFolder: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
}

/**
 * One row: filter on the left, actions on the right — same idea as VS Code's explorer header.
 */
export default function FilesPanelHeader({
  filterQuery,
  onFilterChange,
  onNewFile,
  onNewFolder,
  onExpandAll,
  onCollapseAll
}: Props): React.ReactElement {
  return (
    <div className="px-2 pt-1.5 pb-1.5 border-b border-hair shrink-0 flex items-center gap-1">
      <Field
        className="flex-1 min-w-0 h-(--ctl-h-sm) text-sm"
        value={filterQuery}
        onChange={(e) => onFilterChange(e.target.value)}
        placeholder="Filter"
        aria-label="Filter files"
      />
      <button type="button" className={iconBtnCls} title="New file" aria-label="New file" onClick={onNewFile}>
        <FilePlus size={14} />
      </button>
      <button type="button" className={iconBtnCls} title="New folder" aria-label="New folder" onClick={onNewFolder}>
        <FolderPlus size={14} />
      </button>
      <button type="button" className={iconBtnCls} title="Expand all" aria-label="Expand all" onClick={onExpandAll}>
        <ChevronsUpDown size={14} />
      </button>
      <button type="button" className={iconBtnCls} title="Collapse all" aria-label="Collapse all" onClick={onCollapseAll}>
        <ChevronsDownUp size={14} />
      </button>
    </div>
  )
}
