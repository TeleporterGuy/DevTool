import React from 'react'
import { FilePlus, FolderPlus } from 'lucide-react'
import { Field } from './ui'

const iconBtnCls =
  'flex items-center justify-center size-7 shrink-0 rounded-md bg-transparent border-0 text-text-muted hover:text-text hover:bg-surface-3 cursor-pointer'

interface Props {
  filterQuery: string
  onFilterChange: (value: string) => void
  onNewFile: () => void
  onNewFolder: () => void
  onCollapseAll: () => void
}

/** VS Code-style collapse-all: front square with a minus, rear square peeking bottom-left. */
function CollapseAllIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="5.5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <rect x="5.5" y="1.5" width="9" height="9" rx="1" fill="var(--color-surface)" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 6h4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

/**
 * One row: filter on the left, actions on the right — same idea as VS Code's explorer header.
 */
export default function FilesPanelHeader({
  filterQuery,
  onFilterChange,
  onNewFile,
  onNewFolder,
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
      <button type="button" className={iconBtnCls} title="Collapse all" aria-label="Collapse all" onClick={onCollapseAll}>
        <CollapseAllIcon />
      </button>
    </div>
  )
}
