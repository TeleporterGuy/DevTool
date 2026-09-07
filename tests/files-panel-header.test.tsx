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
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onExpandAll: vi.fn(),
    onCollapseAll: vi.fn(),
    ...overrides
  }
  render(<FilesPanelHeader {...props} />)
  return props
}

describe('FilesPanelHeader', () => {
  it('keeps filter and actions on one row', () => {
    renderHeader()
    expect(screen.getByLabelText('Filter files')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New file' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeTruthy()
  })

  it('calls create and expand handlers from the toolbar', () => {
    const props = renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'New file' }))
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(props.onNewFile).toHaveBeenCalledTimes(1)
    expect(props.onNewFolder).toHaveBeenCalledTimes(1)
    expect(props.onExpandAll).toHaveBeenCalledTimes(1)
    expect(props.onCollapseAll).toHaveBeenCalledTimes(1)
  })

  it('has no ignore UI', () => {
    renderHeader()
    expect(screen.queryByText('Show ignored')).toBeNull()
    expect(screen.queryByText('Ignore')).toBeNull()
  })
})
