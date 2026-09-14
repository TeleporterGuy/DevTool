import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Play, RotateCw, Square } from 'lucide-react'
import { DEFAULT_CONFIG } from '../../shared/types'
import {
  addCellAt,
  applyKernelEventToOutputs,
  changeCellTypeAt,
  deleteCellAt,
  moveCell,
  parseNotebook,
  replaceCellOutputs,
  serializeNotebook,
  updateCellSource,
  type NotebookCellType,
  type NotebookDocument,
  type NotebookKernelStatus
} from '../../shared/notebook'
import {
  beginRunAll,
  beginSingleRun,
  cellIdFromRequestId,
  completeRun,
  idleRunQueue,
  makeExecuteRequestId,
  type NotebookRunQueueState
} from '../../shared/notebook-execute'
import { useApp } from '../context/AppContext'
import { useDirtyBufferStore } from '../context/DirtyBufferContext'
import { FILE_BROWSER_REFRESH_MS } from '../hooks/fileBrowserRefresh'
import NotebookCellView from './NotebookCell'
import { formatShortcutForApp } from '../../shared/shortcut-label'

interface Props {
  tabId: string
  visible: boolean
  filePath: string
  projectDir: string
  projectId: string
  effectiveTheme: 'dark' | 'light'
}

function statusLabel(status: NotebookKernelStatus): string {
  if (status === 'starting') return 'starting'
  if (status === 'busy') return 'busy'
  if (status === 'dead') return 'dead'
  if (status === 'error') return 'error'
  return 'idle'
}

export default function NotebookTab({
  tabId,
  visible,
  filePath,
  projectDir,
  projectId,
  effectiveTheme
}: Props): React.ReactElement {
  const { config } = useApp()
  const dirtyBuffers = useDirtyBufferStore()
  const monacoConfig = config ?? DEFAULT_CONFIG

  const [doc, setDoc] = useState<NotebookDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [kernelStatus, setKernelStatus] = useState<NotebookKernelStatus>('starting')
  const [kernelError, setKernelError] = useState<string | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [activeCellId, setActiveCellId] = useState<string | null>(null)
  const [editingMarkdownId, setEditingMarkdownId] = useState<string | null>(null)
  const [everVisible, setEverVisible] = useState(visible)
  const [loadGeneration, setLoadGeneration] = useState(0)

  const docRef = useRef<NotebookDocument | null>(null)
  const savedRef = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const requestIdRef = useRef(0)
  const executeSeqRef = useRef(0)
  const runStateRef = useRef<NotebookRunQueueState>(idleRunQueue())
  const kernelStatusRef = useRef<NotebookKernelStatus>('starting')

  const markDirty = useCallback((next: NotebookDocument) => {
    docRef.current = next
    const serialized = serializeNotebook(next)
    const isDirty = savedRef.current !== null && serialized !== savedRef.current
    dirtyRef.current = isDirty
    setDirty(isDirty)
    setDoc(next)
  }, [])

  const refreshContent = useCallback((force = false) => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    window.api.fbReadFile(projectDir, filePath).then((text) => {
      if (requestId !== requestIdRef.current) return
      if (!force && dirtyRef.current) return
      try {
        const parsed = parseNotebook(text)
        const serialized = serializeNotebook(parsed)
        if (!force && savedRef.current !== null && serialized === savedRef.current) return
        savedRef.current = serialized
        docRef.current = parsed
        dirtyRef.current = false
        setDirty(false)
        setError(null)
        setDoc(parsed)
        setLoadGeneration((n) => n + 1)
        setActiveCellId((current) => current ?? parsed.cells[0]?.id ?? null)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setDoc(null)
      }
    }).catch(() => {
      if (requestId !== requestIdRef.current) return
      if (!force && dirtyRef.current) return
      setError('Unable to read file.')
      setDoc(null)
    })
  }, [filePath, projectDir])

  useEffect(() => {
    setDoc(null)
    setError(null)
    setSaveError(null)
    savedRef.current = null
    docRef.current = null
    dirtyRef.current = false
    setDirty(false)
    refreshContent(true)
    return () => {
      requestIdRef.current += 1
    }
  }, [refreshContent])

  useEffect(() => {
    if (!visible) return
    refreshContent()
    const intervalId = window.setInterval(() => refreshContent(), FILE_BROWSER_REFRESH_MS)
    const handleFocus = () => refreshContent()
    const handleReload = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (detail?.tabId && detail.tabId !== tabId) return
      refreshContent(true)
    }
    window.addEventListener('focus', handleFocus)
    window.addEventListener('reload-file-tab', handleReload)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('reload-file-tab', handleReload)
    }
  }, [refreshContent, tabId, visible])

  useEffect(() => {
    if (visible) setEverVisible(true)
  }, [visible])

  const writeBuffer = useCallback((): Promise<void> => {
    const current = docRef.current
    if (!current) return Promise.resolve()
    const value = serializeNotebook(current)
    setSaveError(null)
    return window.api.fbWriteFile(projectDir, filePath, value).then(() => {
      savedRef.current = value
      dirtyRef.current = serializeNotebook(docRef.current ?? current) !== value
      setDirty(dirtyRef.current)
      setSaveError(null)
      window.dispatchEvent(new CustomEvent('file-saved', { detail: { filePath, projectDir } }))
    }, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      setSaveError(message ? `Save failed: ${message}` : 'Save failed.')
      throw err
    })
  }, [filePath, projectDir])

  const saveContent = useCallback(() => {
    void writeBuffer().catch(() => {})
  }, [writeBuffer])

  const writeBufferRef = useRef(writeBuffer)
  useEffect(() => {
    writeBufferRef.current = writeBuffer
  }, [writeBuffer])

  useEffect(() => {
    const token = dirtyBuffers.registerBuffer(tabId, {
      filePath,
      isDirty: dirty,
      save: () => writeBufferRef.current()
    })
    return () => dirtyBuffers.unregisterBuffer(tabId, token)
  }, [dirtyBuffers, tabId, filePath, dirty])

  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveContent()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, saveContent])

  const startKernel = useCallback(() => {
    setKernelError(null)
    setKernelStatus('starting')
    kernelStatusRef.current = 'starting'
    void window.api.notebookKernelStart(tabId, projectId, projectDir).then((result) => {
      if (result?.error) {
        setKernelError(result.error)
        setKernelStatus('error')
        kernelStatusRef.current = 'error'
      }
    })
  }, [projectDir, projectId, tabId])

  useEffect(() => {
    if (!everVisible) return
    startKernel()
    return () => {
      void window.api.notebookKernelShutdown(tabId)
    }
  }, [startKernel, tabId, everVisible])

  const clearRunQueue = useCallback(() => {
    runStateRef.current = idleRunQueue()
    setRunningIds(new Set())
  }, [])

  const sendExecute = useCallback((cellId: string) => {
    const current = docRef.current
    const cell = current?.cells.find((item) => item.id === cellId)
    if (!current || !cell || cell.cellType !== 'code') {
      const { state, next } = completeRun(runStateRef.current, cellId)
      runStateRef.current = state
      if (next) sendExecute(next)
      return
    }
    if (kernelStatusRef.current === 'error' || kernelStatusRef.current === 'dead') {
      setKernelError((prev) => prev ?? 'Kernel is not running. Click Restart kernel.')
      clearRunQueue()
      return
    }
    markDirty(replaceCellOutputs(current, cellId, [], cell.executionCount))
    setRunningIds((prev) => new Set(prev).add(cellId))
    executeSeqRef.current += 1
    const requestId = makeExecuteRequestId(cellId, executeSeqRef.current)
    void window.api.notebookKernelExecute(tabId, requestId, cell.source, cellId).then((result) => {
      if (!result?.error) return
      setKernelError(result.error)
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(cellId)
        return next
      })
      if (/not running/i.test(result.error)) {
        clearRunQueue()
        return
      }
      const finished = completeRun(runStateRef.current, cellId)
      runStateRef.current = finished.state
      if (finished.next) sendExecute(finished.next)
    })
  }, [clearRunQueue, markDirty, tabId])

  const requestSingleRun = useCallback((cellId: string) => {
    const previous = runStateRef.current
    const nextState = beginSingleRun(previous, cellId)
    runStateRef.current = nextState
    // Only dispatch when this cell is the one that just became in-flight.
    // A mid-flight Run is appended; it must not wipe Run-all.
    if (!previous.inFlight && nextState.inFlight === cellId) {
      sendExecute(cellId)
    }
  }, [sendExecute])

  useEffect(() => {
    const unsubscribe = window.api.onNotebookKernelEvent((id, event) => {
      if (id !== tabId) return
      if (event.event === 'status') {
        const next = event.execution_state === 'dead' ? 'dead' : event.execution_state
        kernelStatusRef.current = next
        setKernelStatus(next)
        return
      }
      if (event.event === 'ready') {
        kernelStatusRef.current = 'idle'
        setKernelStatus('idle')
        setKernelError(null)
        return
      }
      if (event.event === 'fail') {
        kernelStatusRef.current = 'error'
        setKernelStatus('error')
        setKernelError(event.message)
        clearRunQueue()
        return
      }
      if (event.event === 'dead') {
        kernelStatusRef.current = 'dead'
        setKernelStatus('dead')
        if (event.message) setKernelError(event.message)
        clearRunQueue()
        return
      }
      const cellId = 'id' in event ? cellIdFromRequestId(event.id, event.cellId) : null
      if (event.event === 'execute_reply') {
        const current = docRef.current
        if (cellId && current && typeof event.execution_count === 'number') {
          const cell = current.cells.find((item) => item.id === cellId)
          if (cell) {
            markDirty(replaceCellOutputs(current, cellId, cell.outputs, event.execution_count))
          }
        }
        if (cellId) {
          setRunningIds((prev) => {
            const next = new Set(prev)
            next.delete(cellId)
            return next
          })
          const finished = completeRun(runStateRef.current, cellId)
          runStateRef.current = finished.state
          if (finished.next) sendExecute(finished.next)
        }
        return
      }
      if (!cellId) return
      const current = docRef.current
      const cell = current?.cells.find((item) => item.id === cellId)
      if (!current || !cell) return
      const nextOutputs = applyKernelEventToOutputs(cell.outputs, event)
      if (nextOutputs) markDirty(replaceCellOutputs(current, cellId, nextOutputs))
    })
    return unsubscribe
  }, [clearRunQueue, markDirty, sendExecute, tabId])

  const runActive = useCallback(() => {
    const current = docRef.current
    if (!current) return
    const cell = current.cells.find((item) => item.id === activeCellId) ?? current.cells[0]
    if (!cell) return
    if (cell.cellType === 'markdown') {
      setEditingMarkdownId(null)
      return
    }
    if (cell.cellType === 'raw') return
    requestSingleRun(cell.id)
  }, [activeCellId, requestSingleRun])

  const runAndNext = useCallback(() => {
    const current = docRef.current
    if (!current) return
    const index = current.cells.findIndex((item) => item.id === activeCellId)
    const cell = index >= 0 ? current.cells[index] : current.cells[0]
    if (!cell) return
    if (cell.cellType === 'markdown') {
      setEditingMarkdownId(null)
    } else if (cell.cellType === 'code') {
      requestSingleRun(cell.id)
    }
    const latest = docRef.current ?? current
    const next = latest.cells[index + 1]
    if (next) {
      setActiveCellId(next.id)
      if (next.cellType === 'markdown') setEditingMarkdownId(next.id)
    } else {
      const withNew = addCellAt(latest, latest.cells.length, 'code')
      const created = withNew.cells[withNew.cells.length - 1]
      markDirty(withNew)
      setActiveCellId(created.id)
    }
  }, [activeCellId, markDirty, requestSingleRun])

  const runAll = useCallback(() => {
    const current = docRef.current
    if (!current) return
    // Do not replace an in-flight Run / Run-all; that would double-send the first cell.
    if (runStateRef.current.inFlight || runStateRef.current.queued.length > 0) return
    const ids = current.cells.filter((cell) => cell.cellType === 'code').map((cell) => cell.id)
    if (ids.length === 0) return
    const nextState = beginRunAll(ids)
    runStateRef.current = nextState
    if (nextState.inFlight) sendExecute(nextState.inFlight)
  }, [sendExecute])

  const restartKernel = useCallback(() => {
    clearRunQueue()
    setKernelError(null)
    setKernelStatus('starting')
    kernelStatusRef.current = 'starting'
    void window.api.notebookKernelRestart(tabId, projectId, projectDir).then((result) => {
      if (result?.error) {
        setKernelError(result.error)
        setKernelStatus('error')
        kernelStatusRef.current = 'error'
      }
    })
  }, [clearRunQueue, projectDir, projectId, tabId])

  const interruptKernel = useCallback(() => {
    void window.api.notebookKernelInterrupt(tabId)
  }, [tabId])

  if (!visible && !everVisible) return <div style={{ display: 'none' }} />

  const statusColor =
    kernelStatus === 'busy' || kernelStatus === 'starting'
      ? 'var(--color-warn)'
      : kernelStatus === 'dead' || kernelStatus === 'error'
        ? 'var(--color-danger)'
        : 'var(--color-success)'

  return (
    <div style={{ position: 'absolute', inset: 0, display: visible ? 'flex' : 'none', flexDirection: 'column' }}>
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-hair bg-surface-2 shrink-0">
        <button
          type="button"
          className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text disabled:opacity-40"
          onClick={runActive}
          title={`Run cell (${formatShortcutForApp('CmdOrCtrl+Enter')})`}
        >
          <span className="inline-flex items-center gap-1"><Play size={12} /> Run</span>
        </button>
        <button
          type="button"
          className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text"
          onClick={runAll}
          title="Run all code cells"
        >
          Run all
        </button>
        <button
          type="button"
          className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text"
          onClick={restartKernel}
          title="Restart kernel"
        >
          <span className="inline-flex items-center gap-1"><RotateCw size={12} /> Restart</span>
        </button>
        <button
          type="button"
          className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text disabled:opacity-40"
          onClick={interruptKernel}
          disabled={kernelStatus !== 'busy'}
          title="Interrupt kernel"
        >
          <span className="inline-flex items-center gap-1"><Square size={12} /> Interrupt</span>
        </button>
        <span className="flex items-center gap-1.5 ml-2 text-xs text-text-muted">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
          Kernel {statusLabel(kernelStatus)}
        </span>
        <span className="flex-1" />
        <span className="text-2xs text-text-subtle truncate" title={filePath}>{filePath}</span>
      </div>

      {kernelError && (
        <div role="alert" className="px-3 py-2 text-sm border-b border-hair" style={{ color: 'var(--color-danger)' }}>
          {kernelError}
        </div>
      )}

      {doc === null ? (
        <div className="tab-content-placeholder">{error ?? 'Loading...'}</div>
      ) : (
        <div className="flex-1 overflow-y-auto py-2">
          {doc.cells.map((cell, index) => (
            <NotebookCellView
              key={cell.id}
              cell={cell}
              index={index}
              cellCount={doc.cells.length}
              isActive={cell.id === activeCellId}
              isEditingMarkdown={editingMarkdownId === cell.id}
              isRunning={runningIds.has(cell.id)}
              config={monacoConfig}
              effectiveTheme={effectiveTheme}
              onFocus={() => setActiveCellId(cell.id)}
              onChangeSource={(source) => {
                const current = docRef.current
                if (!current) return
                markDirty(updateCellSource(current, cell.id, source))
              }}
              onRun={() => {
                setActiveCellId(cell.id)
                if (cell.cellType === 'markdown') {
                  setEditingMarkdownId(null)
                  return
                }
                requestSingleRun(cell.id)
              }}
              onRunAndNext={runAndNext}
              onChangeType={(type: NotebookCellType) => {
                const current = docRef.current
                if (!current) return
                markDirty(changeCellTypeAt(current, index, type))
              }}
              onAddBelow={() => {
                const current = docRef.current
                if (!current) return
                const next = addCellAt(current, index + 1, 'code')
                markDirty(next)
                setActiveCellId(next.cells[index + 1]?.id ?? null)
              }}
              onDelete={() => {
                const current = docRef.current
                if (!current) return
                const next = deleteCellAt(current, index)
                markDirty(next)
                setActiveCellId(next.cells[Math.min(index, next.cells.length - 1)]?.id ?? null)
              }}
              onMove={(direction) => {
                const current = docRef.current
                if (!current) return
                markDirty(moveCell(current, index, index + direction))
              }}
              onStartMarkdownEdit={() => {
                setActiveCellId(cell.id)
                setEditingMarkdownId(cell.id)
              }}
              resetKey={loadGeneration}
            />
          ))}
        </div>
      )}

      {saveError !== null && (
        <div
          role="alert"
          className="absolute bottom-2 left-2 right-2 z-(--z-sticky) flex items-center gap-2 bg-surface border border-border rounded-md px-2 py-1 text-sm leading-snug"
          style={{ color: 'var(--color-danger)' }}
        >
          <span className="flex-1 truncate" title={saveError}>{saveError}</span>
          <button className="text-accent cursor-pointer hover:underline" onClick={saveContent}>Retry</button>
          <button className="text-accent cursor-pointer hover:underline" onClick={() => setSaveError(null)}>Dismiss</button>
        </div>
      )}
      {dirty && (
        <div
          title="Unsaved changes"
          style={{ position: 'absolute', top: 8, right: 12, width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)', zIndex: 5 }}
        />
      )}
    </div>
  )
}
