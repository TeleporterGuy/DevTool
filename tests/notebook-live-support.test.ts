import { describe, expect, it } from 'vitest'
import { notebookLiveHelperPath, notebookLiveRequested } from './notebook-live-support'

describe('notebook live smoke gate', () => {
  it('skips unless NOTEBOOK_LIVE or NOTEBOOK_LIVE_REQUIRED is set', () => {
    expect(notebookLiveRequested({})).toBe(false)
    expect(notebookLiveRequested({ CI: 'true' })).toBe(false)
    expect(notebookLiveRequested({ NOTEBOOK_LIVE: '1' })).toBe(true)
    expect(notebookLiveRequested({ NOTEBOOK_LIVE_REQUIRED: '1' })).toBe(true)
  })

  it('points at the repo helper, not a packaged asar path', () => {
    expect(notebookLiveHelperPath('/repo')).toMatch(/resources[/\\]notebook-kernel\.py$/)
  })
})
