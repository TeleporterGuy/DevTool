import React, { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { ChevronDown, ChevronUp, Play, Plus, Trash2 } from 'lucide-react'
import type { AppConfig } from '../../shared/types'
import type { NotebookCell, NotebookCellType } from '../../shared/notebook'
import { buildMonacoNotebookCellOptions } from './monacoOptions'
import { defineMonacoThemes, monacoThemeFor } from './monacoTheme'
import MarkdownPreview from './MarkdownPreview'
import NotebookOutputs from './NotebookOutputs'

interface Props {
  cell: NotebookCell
  index: number
  cellCount: number
  isActive: boolean
  isEditingMarkdown: boolean
  isRunning: boolean
  config: AppConfig
  effectiveTheme: 'dark' | 'light'
  onFocus: () => void
  onChangeSource: (source: string) => void
  onRun: () => void
  onRunAndNext: () => void
  onChangeType: (type: NotebookCellType) => void
  onAddBelow: () => void
  onDelete: () => void
  onMove: (direction: -1 | 1) => void
  onStartMarkdownEdit: () => void
  resetKey: number
}

const RUN_KEY = 2048 | 3
const RUN_AND_NEXT_KEY = 2048 | 1024 | 3

export default function NotebookCellView({
  cell,
  index,
  cellCount,
  isActive,
  isEditingMarkdown,
  isRunning,
  config,
  effectiveTheme,
  onFocus,
  onChangeSource,
  onRun,
  onRunAndNext,
  onChangeType,
  onAddBelow,
  onDelete,
  onMove,
  onStartMarkdownEdit,
  resetKey
}: Props): React.ReactElement {
  const [height, setHeight] = useState(64)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const onRunRef = useRef(onRun)
  const onRunAndNextRef = useRef(onRunAndNext)
  const showMarkdownPreview = cell.cellType === 'markdown' && !isEditingMarkdown
  const language = cell.cellType === 'code' ? 'python' : 'markdown'

  useEffect(() => {
    onRunRef.current = onRun
    onRunAndNextRef.current = onRunAndNext
  }, [onRun, onRunAndNext])

  useEffect(() => {
    editorRef.current?.updateOptions(buildMonacoNotebookCellOptions(config))
    editorRef.current?.layout()
  }, [config])

  const handleMount = (ed: editor.IStandaloneCodeEditor) => {
    editorRef.current = ed
    ed.addCommand(RUN_KEY, () => onRunRef.current())
    ed.addCommand(RUN_AND_NEXT_KEY, () => onRunAndNextRef.current())
    const applyHeight = () => {
      const next = Math.max(48, Math.min(520, ed.getContentHeight() + 4))
      setHeight(next)
    }
    ed.onDidContentSizeChange(applyHeight)
    applyHeight()
  }

  const btnCls =
    'bg-transparent border-0 text-text-muted cursor-pointer p-1 rounded-md hover:bg-surface-3 hover:text-text disabled:opacity-40 disabled:cursor-default'

  return (
    <div
      className={`mx-2 mb-2 rounded-md border ${isActive ? 'border-border-focus' : 'border-border'}`}
      onMouseDown={onFocus}
    >
      <div className="flex items-center gap-1 px-1.5 py-0.5 bg-surface-2 border-b border-hair">
        <span className="text-2xs text-text-subtle w-8 shrink-0 text-right font-mono">
          {cell.cellType === 'code' && cell.executionCount != null ? `[${cell.executionCount}]` : `[ ]`}
        </span>
        <select
          className="bg-field border border-border text-text text-xs rounded-md px-1 py-0.5"
          value={cell.cellType}
          onChange={(e) => onChangeType(e.target.value as NotebookCellType)}
          aria-label="Cell type"
        >
          <option value="code">Code</option>
          <option value="markdown">Markdown</option>
          <option value="raw">Raw</option>
        </select>
        {cell.cellType === 'code' && (
          <button
            type="button"
            className={btnCls}
            onClick={onRun}
            title="Run cell (Ctrl+Enter)"
            disabled={isRunning}
          >
            <Play size={14} />
          </button>
        )}
        {isRunning && <span className="text-2xs text-accent">running…</span>}
        <span className="flex-1" />
        <button type="button" className={btnCls} onClick={onAddBelow} title="Add cell below">
          <Plus size={14} />
        </button>
        <button
          type="button"
          className={btnCls}
          onClick={() => onMove(-1)}
          disabled={index === 0}
          title="Move up"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          className={btnCls}
          onClick={() => onMove(1)}
          disabled={index === cellCount - 1}
          title="Move down"
        >
          <ChevronDown size={14} />
        </button>
        <button type="button" className={btnCls} onClick={onDelete} title="Delete cell">
          <Trash2 size={14} />
        </button>
      </div>

      {showMarkdownPreview ? (
        <button
          type="button"
          className="block w-full text-left bg-transparent border-0 p-0 cursor-text"
          onClick={onStartMarkdownEdit}
        >
          {cell.source.trim()
            ? (
              <MarkdownPreview
                content={cell.source}
                effectiveTheme={effectiveTheme}
                variant="notebook"
                fontSize={config.editorFontSize}
              />
            )
            : <div className="px-3 py-4 text-sm text-text-muted italic">Empty markdown cell — click to edit</div>}
        </button>
      ) : (
        <div style={{ height }}>
          <Editor
            key={`${cell.id}-${cell.cellType}-${resetKey}`}
            path={`${cell.id}.${cell.cellType === 'code' ? 'py' : 'md'}`}
            height={height}
            defaultValue={cell.source}
            language={language}
            theme={monacoThemeFor(effectiveTheme)}
            beforeMount={defineMonacoThemes}
            options={buildMonacoNotebookCellOptions(config)}
            onMount={handleMount}
            onChange={(value) => onChangeSource(value ?? '')}
          />
        </div>
      )}

      {cell.cellType === 'code' && <NotebookOutputs outputs={cell.outputs} />}
    </div>
  )
}
