import React, { useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { Check, ChevronDown, ChevronRight, ChevronUp, Play, Plus, Trash2 } from 'lucide-react'
import type { AppConfig } from '../../shared/types'
import {
  isNotebookCellCollapsed,
  notebookCellSourcePreview,
  type NotebookCell,
  type NotebookCellType
} from '../../shared/notebook'
import { isIgnorableRendererError } from '../renderer-errors'
import { buildMonacoNotebookCellOptions, notebookCellEditorHeight } from './monacoOptions'
import { notebookCellMountsMonaco } from './notebookCellEditor'
import { defineMonacoThemes, monacoThemeFor } from './monacoTheme'
import MarkdownPreview from './MarkdownPreview'
import NotebookOutputs from './NotebookOutputs'
import {
  highlightNotebookCodeHtml,
  NOTEBOOK_CODE_PREVIEW_CODE_CLASS
} from './notebookCodePreview'

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
  onFinishMarkdownEdit: () => void
  onToggleCollapsed: () => void
  resetKey: number
  suspendEditors?: boolean
}

const RUN_KEY = 2048 | 3
const RUN_AND_NEXT_KEY = 2048 | 1024 | 3
const ESCAPE_KEY = 9 // Monaco KeyCode.Escape

function safeMonacoCall(fn: () => void): void {
  try {
    fn()
  } catch {
    /* layout/dispose can throw if Monaco already tore down during a cell move */
  }
}

class CellEditorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    if (isIgnorableRendererError(error)) {
      console.warn('Ignoring notebook Monaco noise', error)
      return
    }
    console.error('Notebook cell editor crashed', error)
  }

  render(): React.ReactNode {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

function NotebookCellSourcePre({
  source,
  fontFamily,
  fontSize,
  cellType
}: {
  source: string
  fontFamily?: string
  fontSize?: number
  cellType: NotebookCellType
}): React.ReactElement {
  const highlightCode = cellType === 'code'
  const highlightedHtml = useMemo(
    () => (highlightCode ? highlightNotebookCodeHtml(source) : null),
    [highlightCode, source]
  )

  return (
    <pre
      data-testid="notebook-cell-source-pre"
      className={
        highlightCode
          ? 'note-preview notebook-code-preview m-0 px-3 py-2 text-sm text-text whitespace-pre-wrap break-words cursor-text min-h-[48px]'
          : 'm-0 px-3 py-2 text-sm text-text whitespace-pre-wrap break-words cursor-text min-h-[48px]'
      }
      style={{
        fontFamily: fontFamily || 'var(--font-mono)',
        fontSize
      }}
    >
      {highlightedHtml != null ? (
        <code
          className={NOTEBOOK_CODE_PREVIEW_CODE_CLASS}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        source || ' '
      )}
    </pre>
  )
}

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
  onFinishMarkdownEdit,
  onToggleCollapsed,
  resetKey,
  suspendEditors = false
}: Props): React.ReactElement {
  const [height, setHeight] = useState(64)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const sizeSubRef = useRef<{ dispose: () => void } | null>(null)
  const onRunRef = useRef(onRun)
  const onRunAndNextRef = useRef(onRunAndNext)
  const onChangeSourceRef = useRef(onChangeSource)
  const onFinishMarkdownEditRef = useRef(onFinishMarkdownEdit)
  const cellTypeRef = useRef(cell.cellType)
  const collapsed = isNotebookCellCollapsed(cell)
  const sourcePreview = notebookCellSourcePreview(cell.source)
  const showMarkdownPreview = cell.cellType === 'markdown' && !isEditingMarkdown
  const mountMonaco = notebookCellMountsMonaco({
    isActive,
    collapsed,
    cellType: cell.cellType,
    isEditingMarkdown,
    suspendEditors
  })
  const language = cell.cellType === 'code' ? 'python' : 'markdown'

  useEffect(() => {
    onRunRef.current = onRun
    onRunAndNextRef.current = onRunAndNext
    onChangeSourceRef.current = onChangeSource
    onFinishMarkdownEditRef.current = onFinishMarkdownEdit
    cellTypeRef.current = cell.cellType
  }, [cell.cellType, onChangeSource, onFinishMarkdownEdit, onRun, onRunAndNext])

  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    safeMonacoCall(() => {
      ed.updateOptions(buildMonacoNotebookCellOptions(config))
      ed.layout()
    })
  }, [config])

  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    safeMonacoCall(() => ed.layout())
  }, [height])

  useEffect(() => {
    if (mountMonaco) return
    safeMonacoCall(() => sizeSubRef.current?.dispose())
    sizeSubRef.current = null
    editorRef.current = null
  }, [mountMonaco])

  useEffect(() => () => {
    safeMonacoCall(() => sizeSubRef.current?.dispose())
    sizeSubRef.current = null
    editorRef.current = null
  }, [])

  const handleMount = (ed: editor.IStandaloneCodeEditor) => {
    editorRef.current = ed
    ed.addCommand(RUN_KEY, () => onRunRef.current())
    ed.addCommand(RUN_AND_NEXT_KEY, () => onRunAndNextRef.current())
    ed.addCommand(ESCAPE_KEY, () => {
      if (cellTypeRef.current === 'markdown') onFinishMarkdownEditRef.current()
    })
    const applyHeight = () => {
      // Content-size events can fire while Monaco is disposing during a cell reorder.
      try {
        if (editorRef.current !== ed) return
        setHeight(notebookCellEditorHeight(ed.getContentHeight()))
      } catch {
        /* ignore disposed editor */
      }
    }
    safeMonacoCall(() => sizeSubRef.current?.dispose())
    try {
      sizeSubRef.current = ed.onDidContentSizeChange(applyHeight)
    } catch {
      sizeSubRef.current = null
    }
    applyHeight()
  }

  const btnCls =
    'bg-transparent border-0 text-text-muted cursor-pointer p-1 rounded-md hover:bg-surface-3 hover:text-text disabled:opacity-40 disabled:cursor-default'

  return (
    <div
      className={`mx-2 mb-2 rounded-md border ${isActive ? 'border-border-focus' : 'border-border'}`}
      onMouseDown={onFocus}
    >
      <div className={`flex items-center gap-1 px-1.5 py-0.5 bg-surface-2 ${collapsed ? '' : 'border-b border-hair'}`}>
        <button
          type="button"
          className={btnCls}
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand cell' : 'Collapse cell'}
          title={collapsed ? 'Expand cell' : 'Collapse cell'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
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
        {cell.cellType === 'markdown' && isEditingMarkdown && (
          <button
            type="button"
            className={btnCls}
            onClick={onFinishMarkdownEdit}
            title="Preview markdown"
            aria-label="Preview markdown"
          >
            <Check size={14} />
          </button>
        )}
        {isRunning && <span className="text-2xs text-accent">running…</span>}
        {collapsed ? (
          <span className="min-w-0 flex-1 truncate text-2xs text-text-muted" title={sourcePreview || undefined}>
            {sourcePreview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
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

      {!collapsed && (
        <>
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
          ) : mountMonaco ? (
            <CellEditorBoundary
              key={`${cell.id}-${resetKey}`}
              fallback={(
                <NotebookCellSourcePre
                  source={cell.source}
                  fontFamily={config.editorFontFamily}
                  fontSize={config.editorFontSize}
                  cellType={cell.cellType}
                />
              )}
            >
              <div style={{ height }} data-testid="notebook-cell-monaco">
                <Editor
                  key={`${cell.cellType}-${resetKey}`}
                  height={height}
                  defaultValue={cell.source}
                  language={language}
                  theme={monacoThemeFor(effectiveTheme)}
                  beforeMount={defineMonacoThemes}
                  options={buildMonacoNotebookCellOptions(config)}
                  onMount={handleMount}
                  onChange={(value) => {
                    if (editorRef.current) onChangeSourceRef.current(value ?? '')
                  }}
                />
              </div>
            </CellEditorBoundary>
          ) : (
            <NotebookCellSourcePre
              source={cell.source}
              fontFamily={config.editorFontFamily}
              fontSize={config.editorFontSize}
              cellType={cell.cellType}
            />
          )}

          {cell.cellType === 'code' && <NotebookOutputs outputs={cell.outputs} />}
        </>
      )}
    </div>
  )
}
