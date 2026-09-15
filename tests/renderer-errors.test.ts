import { describe, expect, it } from 'vitest'
import { isIgnorableRendererError } from '../src/renderer/renderer-errors'

describe('isIgnorableRendererError', () => {
  it('ignores ResizeObserver loop noise from moving Monaco cells', () => {
    expect(
      isIgnorableRendererError(
        new Error('ResizeObserver loop completed with undelivered notifications.')
      )
    ).toBe(true)
    expect(isIgnorableRendererError(undefined, 'ResizeObserver loop limit exceeded')).toBe(true)
  })

  it('does not ignore real renderer failures', () => {
    expect(isIgnorableRendererError(new Error("Cannot read properties of undefined (reading 'loadProjects')"))).toBe(false)
    expect(isIgnorableRendererError(undefined, 'Renderer crashed while rendering')).toBe(false)
  })
})
