// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_CONFIG } from '../src/shared/types'
import type { NotebookCell } from '../src/shared/notebook'
import {
  NOTEBOOK_RUN_QUEUE_BUSY_TITLE
} from '../src/shared/notebook-execute'
import NotebookCellView from '../src/renderer/components/NotebookCell'

void React

const mocks = vi.hoisted(() => ({
  commands: new Map<number, () => void>()
}))

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  function MockEditor({ onMount }: { onMount?: (ed: unknown) => void }) {
    const edRef = React.useRef<Record<string, unknown> | null>(null)
    if (edRef.current === null) {
      edRef.current = {
        addCommand: (keybinding: number, handler: () => void) => {
          mocks.commands.set(keybinding, handler)
        },
        updateOptions: () => {},
        layout: () => {},
        getContentHeight: () => 64,
        onDidContentSizeChange: () => ({ dispose: () => {} })
      }
    }
    React.useEffect(() => {
      onMount?.(edRef.current)
    }, [onMount])
    return React.createElement('textarea', { 'data-testid': 'monaco' })
  }
  return { default: MockEditor }
})

vi.mock('../src/renderer/components/monacoTheme', () => ({
  defineMonacoThemes: () => {},
  monacoThemeFor: () => 'devtool-dark'
}))

function cell(overrides: Partial<NotebookCell> = {}): NotebookCell {
  return {
    id: 'cell-1',
    cellType: 'code',
    source: 'print(1)',
    outputs: [],
    executionCount: null,
    metadata: {},
    ...overrides
  }
}

const noop = () => {}

function renderCell(props: {
  isActive: boolean
  isEditingMarkdown?: boolean
  suspendEditors?: boolean
  cell?: NotebookCell
  onFinishMarkdownEdit?: () => void
  onRunAbove?: () => void
  canRunAbove?: boolean
  runAboveTitle?: string
}) {
  return render(
    <NotebookCellView
      cell={props.cell ?? cell()}
      index={0}
      cellCount={2}
      isActive={props.isActive}
      isEditingMarkdown={props.isEditingMarkdown ?? false}
      isRunning={false}
      config={DEFAULT_CONFIG}
      effectiveTheme="dark"
      onFocus={noop}
      onChangeSource={noop}
      onRun={noop}
      onRunAbove={props.onRunAbove}
      canRunAbove={props.canRunAbove}
      runAboveTitle={props.runAboveTitle}
      onRunAndNext={noop}
      onChangeType={noop}
      onAddBelow={noop}
      onDelete={noop}
      onMove={noop}
      onStartMarkdownEdit={noop}
      onFinishMarkdownEdit={props.onFinishMarkdownEdit ?? noop}
      onToggleCollapsed={noop}
      resetKey={0}
      suspendEditors={props.suspendEditors}
    />
  )
}

afterEach(() => {
  mocks.commands.clear()
  cleanup()
})

describe('NotebookCell Monaco mount', () => {
  it('mounts Monaco for the active code cell and shows <pre> when inactive', () => {
    const { rerender } = renderCell({ isActive: true })
    expect(screen.getByTestId('notebook-cell-monaco')).toBeTruthy()
    expect(screen.queryByTestId('notebook-cell-source-pre')).toBeNull()

    rerender(
      <NotebookCellView
        cell={cell()}
        index={0}
        cellCount={2}
        isActive={false}
        isEditingMarkdown={false}
        isRunning={false}
        config={DEFAULT_CONFIG}
        effectiveTheme="dark"
        onFocus={noop}
        onChangeSource={noop}
        onRun={noop}
        onRunAndNext={noop}
        onChangeType={noop}
        onAddBelow={noop}
        onDelete={noop}
        onMove={noop}
        onStartMarkdownEdit={noop}
        onFinishMarkdownEdit={noop}
        onToggleCollapsed={noop}
        resetKey={0}
      />
    )
    expect(screen.queryByTestId('notebook-cell-monaco')).toBeNull()
    expect(screen.getByTestId('notebook-cell-source-pre').textContent).toContain('print(1)')
    expect(screen.getByTestId('notebook-cell-source-pre').querySelector('code.hljs')).toBeTruthy()
  })

  it('leaves idle raw cells as plain text without hljs', () => {
    renderCell({
      isActive: false,
      cell: cell({ cellType: 'raw', source: 'plain text' })
    })
    const pre = screen.getByTestId('notebook-cell-source-pre')
    expect(pre.textContent).toContain('plain text')
    expect(pre.querySelector('code.hljs')).toBeNull()
  })

  it('unmounts Monaco when editors are suspended, even if the cell is active', () => {
    const { rerender } = renderCell({ isActive: true })
    expect(screen.getByTestId('notebook-cell-monaco')).toBeTruthy()
    rerender(
      <NotebookCellView
        cell={cell()}
        index={0}
        cellCount={2}
        isActive={true}
        isEditingMarkdown={false}
        isRunning={false}
        config={DEFAULT_CONFIG}
        effectiveTheme="dark"
        onFocus={noop}
        onChangeSource={noop}
        onRun={noop}
        onRunAndNext={noop}
        onChangeType={noop}
        onAddBelow={noop}
        onDelete={noop}
        onMove={noop}
        onStartMarkdownEdit={noop}
        onFinishMarkdownEdit={noop}
        onToggleCollapsed={noop}
        resetKey={0}
        suspendEditors
      />
    )
    expect(screen.queryByTestId('notebook-cell-monaco')).toBeNull()
    expect(screen.getByTestId('notebook-cell-source-pre')).toBeTruthy()
  })
})

describe('NotebookCell markdown preview control', () => {
  const markdown = cell({ cellType: 'markdown', source: '# Hello' })

  it('shows a check to leave markdown edit and return to preview', () => {
    const onFinish = vi.fn()
    renderCell({
      isActive: true,
      isEditingMarkdown: true,
      cell: markdown,
      onFinishMarkdownEdit: onFinish
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview markdown' }))
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  it('does not show the check on code cells or markdown preview', () => {
    renderCell({ isActive: true })
    expect(screen.queryByRole('button', { name: 'Preview markdown' })).toBeNull()
    cleanup()
    renderCell({ isActive: true, isEditingMarkdown: false, cell: markdown })
    expect(screen.queryByRole('button', { name: 'Preview markdown' })).toBeNull()
  })

  it('finishes markdown edit on Escape in the cell editor', () => {
    const onFinish = vi.fn()
    renderCell({
      isActive: true,
      isEditingMarkdown: true,
      cell: markdown,
      onFinishMarkdownEdit: onFinish
    })
    const escape = mocks.commands.get(9)
    expect(escape).toBeTypeOf('function')
    escape?.()
    expect(onFinish).toHaveBeenCalledTimes(1)
  })
})

describe('NotebookCell collapse', () => {
  it('hides source but still shows outputs under the header', () => {
    renderCell({
      isActive: false,
      cell: cell({
        source: 'print(1)',
        outputs: [{ type: 'stream', name: 'stdout', text: 'hello-output\n' }],
        metadata: { jupyter: { source_hidden: true, outputs_hidden: true } }
      })
    })
    expect(screen.queryByTestId('notebook-cell-monaco')).toBeNull()
    expect(screen.queryByTestId('notebook-cell-source-pre')).toBeNull()
    expect(screen.getByText('print(1)')).toBeTruthy()
    expect(screen.getByText('hello-output')).toBeTruthy()
  })
})

describe('NotebookCell run above', () => {
  it('shows Run all above next to Play on code cells and skips markdown', () => {
    renderCell({ isActive: true, canRunAbove: true })
    expect(screen.getByRole('button', { name: 'Run all above' })).toBeTruthy()
    cleanup()
    renderCell({
      isActive: true,
      isEditingMarkdown: false,
      cell: cell({ cellType: 'markdown', source: '# Hello' })
    })
    expect(screen.queryByRole('button', { name: 'Run all above' })).toBeNull()
  })

  it('disables when there are no code cells above and runs when enabled', () => {
    renderCell({ isActive: true, canRunAbove: false })
    expect((screen.getByRole('button', { name: 'Run all above' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const onRunAbove = vi.fn()
    renderCell({ isActive: true, canRunAbove: true, onRunAbove })
    fireEvent.click(screen.getByRole('button', { name: 'Run all above' }))
    expect(onRunAbove).toHaveBeenCalledTimes(1)
  })

  it('disables Run all above while a run queue is busy and explains why', () => {
    const onRunAbove = vi.fn()
    renderCell({
      isActive: true,
      canRunAbove: false,
      runAboveTitle: NOTEBOOK_RUN_QUEUE_BUSY_TITLE,
      onRunAbove
    })
    const button = screen.getByRole('button', { name: 'Run all above' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe(NOTEBOOK_RUN_QUEUE_BUSY_TITLE)
    fireEvent.click(button)
    expect(onRunAbove).not.toHaveBeenCalled()
  })
})
