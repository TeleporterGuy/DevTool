// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { TabStatusProvider, useTabStatusStore, type TabStatusStore } from '../src/renderer/context/TabStatusContext'

// React import is required by the JSX runtime under vitest's default transform.
void React

function renderStore(): TabStatusStore {
  let store: TabStatusStore | null = null
  function Grab(): null {
    store = useTabStatusStore()
    return null
  }
  render(<TabStatusProvider><Grab /></TabStatusProvider>)
  return store!
}

describe('TabStatusStore.mirrorToMain', () => {
  afterEach(() => {
    cleanup()
    delete (window as { api?: unknown }).api
  })

  it('reports mirrored tabs to main (on register and on change) and nothing else', () => {
    const reportTabStatus = vi.fn().mockResolvedValue(undefined)
    ;(window as { api?: unknown }).api = { reportTabStatus }
    const store = renderStore()

    store.setStatus('codex', 'working')
    const stop = store.mirrorToMain('codex')
    store.setStatus('codex', 'attention')
    store.setStatus('codex', 'attention') // unchanged
    store.setStatus('claude', 'working') // not mirrored: hooks reach main on their own
    stop()
    store.setStatus('codex', null)

    expect(reportTabStatus.mock.calls).toEqual([['codex', 'working'], ['codex', 'attention']])
  })

  it('tolerates a window without the channel', () => {
    ;(window as { api?: unknown }).api = {}
    const store = renderStore()
    store.mirrorToMain('t')
    expect(() => store.setStatus('t', 'working')).not.toThrow()
  })
})
