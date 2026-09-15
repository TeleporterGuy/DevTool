// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { DEFAULT_CONFIG } from '../src/shared/types'
import type { NotebookCell } from '../src/shared/notebook'
import NotebookCellView from '../src/renderer/components/NotebookCell'

void React

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  function MockEditor() {
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
      onToggleCollapsed={noop}
      resetKey={0}
      suspendEditors={props.suspendEditors}
    />
  )
}

afterEach(() => {
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
        onToggleCollapsed={noop}
        resetKey={0}
        suspendEditors
      />
    )
    expect(screen.queryByTestId('notebook-cell-monaco')).toBeNull()
    expect(screen.getByTestId('notebook-cell-source-pre')).toBeTruthy()
  })
})
