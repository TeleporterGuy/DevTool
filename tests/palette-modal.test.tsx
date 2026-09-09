// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react'

// React import is required by the JSX runtime under vitest's default transform.
void React

// Mock the AppContext entirely — Palette only needs a stub of AppActions.
vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => ({
    projects: [],
    notes: {},
    selectedProjectId: null,
    selectedTaskId: null,
    effectiveTheme: 'dark' as const
  })
}))

import { Palette } from '../src/renderer/palette/Palette'

beforeEach(() => {
  ;(window as any).api = {
    paletteFrecencyLoad: vi.fn().mockResolvedValue({ version: 1, entries: {} }),
    paletteFrecencySave: vi.fn().mockResolvedValue(undefined)
  }
})

afterEach(() => {
  cleanup()
})

function pressCmdK() {
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
}

describe('Palette', () => {
  it('opens on Cmd+K and closes on Escape', async () => {
    render(<Palette />)
    await act(async () => { pressCmdK() })
    const input = screen.getByPlaceholderText('type to search…') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }) })
    expect(screen.queryByPlaceholderText('type to search…')).toBeNull()
  })

  it('opens on Ctrl+K', async () => {
    render(<Palette />)
    await act(async () => { fireEvent.keyDown(window, { key: 'k', ctrlKey: true }) })
    expect(screen.getByPlaceholderText('type to search…')).toBeTruthy()
  })

  it('Open Settings has no shortcut glyph or Ctrl+, on Windows', async () => {
    render(<Palette />)
    await act(async () => { pressCmdK() })
    const input = screen.getByPlaceholderText('type to search…') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { value: 'Open Settings' } }) })
    const row = screen.getByRole('button', { name: /Open Settings/ })
    expect(row.textContent).not.toMatch(/⌘/)
    expect(row.textContent).not.toMatch(/Ctrl\+,/)
  })

  it('Toggle Sidebar shows the menu equivalent on this OS', async () => {
    render(<Palette />)
    await act(async () => { pressCmdK() })
    const input = screen.getByPlaceholderText('type to search…') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { value: 'Toggle Sidebar' } }) })
    const row = screen.getByRole('button', { name: /Toggle Sidebar/ })
    const expected = process.platform === 'darwin' ? '⌘B' : 'Ctrl+B'
    expect(row.textContent).toContain(expected)
  })

  it('clicking the > prefix in the footer inserts it into the input', async () => {
    render(<Palette />)
    await act(async () => { pressCmdK() })
    const button = screen.getByTitle(/Run a command/i)
    await act(async () => { fireEvent.click(button) })
    const input = screen.getByPlaceholderText('type to search…') as HTMLInputElement
    expect(input.value.startsWith('>')).toBe(true)
  })
})
