import React from 'react'
import { FilePlus, FolderPlus } from 'lucide-react'
import { Disclosure, Field, HelperText, Switch } from './ui'

const iconBtnCls =
  'flex items-center justify-center size-7 rounded-md bg-transparent border-0 text-text-muted hover:text-text hover:bg-surface-3 cursor-pointer'

interface Props {
  filterQuery: string
  onFilterChange: (value: string) => void
  showIgnored: boolean
  onShowIgnoredChange: (value: boolean) => void
  ignoreOpen: boolean
  onToggleIgnore: () => void
  ignoreDraft: string
  onIgnoreDraftChange: (value: string) => void
  ignoreCount: number
  onSaveIgnore: () => void
  onNewFile: () => void
  onNewFolder: () => void
}

/**
 * Files tab chrome: create actions first (VS Code-style), then filter, then ignore.
 * Extra toolbar buttons can land next to New file / New folder later.
 */
export default function FilesPanelHeader({
  filterQuery,
  onFilterChange,
  showIgnored,
  onShowIgnoredChange,
  ignoreOpen,
  onToggleIgnore,
  ignoreDraft,
  onIgnoreDraftChange,
  ignoreCount,
  onSaveIgnore,
  onNewFile,
  onNewFolder
}: Props): React.ReactElement {
  return (
    <div className="px-2 pt-2 pb-1 border-b border-hair shrink-0 flex flex-col gap-1.5">
      <div className="flex items-center justify-end gap-0.5">
        <button type="button" className={iconBtnCls} title="New file" aria-label="New file" onClick={onNewFile}>
          <FilePlus size={14} />
        </button>
        <button type="button" className={iconBtnCls} title="New folder" aria-label="New folder" onClick={onNewFolder}>
          <FolderPlus size={14} />
        </button>
      </div>
      <Field
        className="w-full h-(--ctl-h-sm) text-sm"
        value={filterQuery}
        onChange={(e) => onFilterChange(e.target.value)}
        placeholder="Filter"
        aria-label="Filter files"
      />
      <label className="flex items-center gap-2 text-xs text-text-muted">
        <Switch checked={showIgnored} onChange={onShowIgnoredChange} />
        Show ignored
      </label>
      <Disclosure
        label="Ignore"
        count={ignoreCount}
        open={ignoreOpen}
        onToggle={onToggleIgnore}
      >
        <textarea
          className="w-full min-h-[88px] mt-1 px-2 py-1 rounded-md bg-field border border-border text-sm text-text outline-none focus:border-border-focus"
          value={ignoreDraft}
          onChange={(e) => onIgnoreDraftChange(e.target.value)}
          spellCheck={false}
          aria-label="Ignore patterns"
        />
        <HelperText>One name or glob per line (* and ?). Not a .gitignore file.</HelperText>
        <button
          type="button"
          className="mt-1 self-start h-(--ctl-h-sm) rounded-md border border-border bg-field px-2 text-sm text-text-muted hover:text-text cursor-pointer"
          onClick={onSaveIgnore}
        >
          Save ignore
        </button>
      </Disclosure>
    </div>
  )
}
