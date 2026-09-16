// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_CONFIG } from '../src/shared/types'
import type { NotebookCell } from '../src/shared/notebook'
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
