// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LinkContextMenu from '../src/renderer/components/LinkContextMenu'
import { chatContextMenuAt } from '../src/renderer/components/claude-chat/chatContextMenu'

void React

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function chat(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

function select(node: Node): Selection {
  const selection = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(node)
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

describe('chatContextMenuAt', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  it('offers an http(s) link under the pointer', () => {
    const root = chat('<p><a href="https://example.com/x"><b>link</b></a></p>')
    expect(chatContextMenuAt(root.querySelector('b')!, root, window.getSelection(), 3, 4))
      .toEqual({ url: 'https://example.com/x', selection: undefined, x: 3, y: 4 })
  })

  it('ignores other links and plain text without a selection', () => {
    const root = chat('<a href="src/main.ts">file</a><p>text</p>')
    expect(chatContextMenuAt(root.querySelector('a')!, root, window.getSelection(), 0, 0)).toBeNull()
    expect(chatContextMenuAt(root.querySelector('p')!, root, window.getSelection(), 0, 0)).toBeNull()
  })

  it('offers the selection when it lies inside the chat', () => {
    const root = chat('<p>hello world</p>')
    const selection = select(root.querySelector('p')!)
    expect(chatContextMenuAt(root.querySelector('p')!, root, selection, 0, 0)?.selection).toBe('hello world')
  })

  it('ignores a selection elsewhere in the window', () => {
    const root = chat('<p>chat</p>')
    const other = chat('<p>elsewhere</p>')
    const selection = select(other.querySelector('p')!)
    expect(chatContextMenuAt(root.querySelector('p')!, root, selection, 0, 0)).toBeNull()
  })

  it('leaves text fields to their own menu', () => {
    const root = chat('<a href="https://example.com"><textarea></textarea></a>')
    expect(chatContextMenuAt(root.querySelector('textarea')!, root, window.getSelection(), 0, 0)).toBeNull()
  })
})

describe('LinkContextMenu', () => {
  const api = { clipboardWriteText: vi.fn(async () => {}), openExternal: vi.fn(async () => {}) }
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', { value: api, configurable: true })
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
  })

  it('opens a link in the system browser', () => {
    const onClose = vi.fn()
    render(<LinkContextMenu menu={{ url: 'https://example.com', x: 0, y: 0 }} onClose={onClose} onOpenInApp={vi.fn()} />)
    expect(screen.queryByText('Copy')).toBeNull()
    fireEvent.click(screen.getByText('Open in System Browser'))
    expect(api.openExternal).toHaveBeenCalledWith('https://example.com')
    expect(onClose).toHaveBeenCalled()
  })

  it('copies a selection, with no link rows when there is no link', () => {
    render(<LinkContextMenu menu={{ selection: 'some text', x: 0, y: 0 }} onClose={vi.fn()} onOpenInApp={vi.fn()} />)
    expect(screen.queryByText('Open in System Browser')).toBeNull()
    fireEvent.click(screen.getByText('Copy'))
    expect(api.clipboardWriteText).toHaveBeenCalledWith('some text')
  })
})
