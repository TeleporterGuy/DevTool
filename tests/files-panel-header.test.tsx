// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FilesPanelHeader from '../src/renderer/components/FilesPanelHeader'

void React

afterEach(() => {
  cleanup()
})

function renderHeader(overrides: Partial<React.ComponentProps<typeof FilesPanelHeader>> = {}) {
  const props: React.ComponentProps<typeof FilesPanelHeader> = {
    filterQuery: '',
    onFilterChange: vi.fn(),
    showIgnored: false,
    onShowIgnoredChange: vi.fn(),
    ignoreOpen: false,
    onToggleIgnore: vi.fn(),
    ignoreDraft: 'node_modules\n__pycache__',
    onIgnoreDraftChange: vi.fn(),
    ignoreCount: 2,
    onSaveIgnore: vi.fn(),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    ...overrides
  }
  render(<FilesPanelHeader {...props} />)
  return props
}

describe('FilesPanelHeader', () => {
  it('puts New file and New folder above the filter', () => {
    renderHeader()
    const newFile = screen.getByRole('button', { name: 'New file' })
    const filter = screen.getByLabelText('Filter files')
    expect(newFile.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('calls create handlers from the toolbar', () => {
    const props = renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    expect(props.onNewFile).toHaveBeenCalledTimes(1)
    expect(props.onNewFolder).toHaveBeenCalledTimes(1)
  })

  it('toggles show ignored without changing the ignore draft', () => {
    const props = renderHeader()
    fireEvent.click(screen.getByRole('switch'))
    expect(props.onShowIgnoredChange).toHaveBeenCalledWith(true)
    expect(props.onIgnoreDraftChange).not.toHaveBeenCalled()
  })

  it('edits and saves the ignore list', () => {
    const props = renderHeader({ ignoreOpen: true })
    fireEvent.change(screen.getByLabelText('Ignore patterns'), { target: { value: 'dist' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save ignore' }))
    expect(props.onIgnoreDraftChange).toHaveBeenCalledWith('dist')
    expect(props.onSaveIgnore).toHaveBeenCalledTimes(1)
  })
})
