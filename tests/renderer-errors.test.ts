import { describe, expect, it } from 'vitest'
import {
  isIgnorableRendererError,
  shouldSkipRendererCrashScreen
} from '../src/renderer/renderer-errors'

describe('isIgnorableRendererError', () => {
  it('ignores ResizeObserver loop noise from moving Monaco cells', () => {
    expect(
      isIgnorableRendererError(
        new Error('ResizeObserver loop completed with undelivered notifications.')
      )
    ).toBe(true)
    expect(isIgnorableRendererError(undefined, 'ResizeObserver loop limit exceeded')).toBe(true)
  })

  it('ignores Monaco canceled / disposed teardown', () => {
    expect(isIgnorableRendererError(new Error('Canceled'))).toBe(true)
    const canceled = new Error('Canceled')
    canceled.name = 'Canceled'
    expect(isIgnorableRendererError(canceled)).toBe(true)
    expect(isIgnorableRendererError({ name: 'Canceled', message: 'Canceled' })).toBe(true)
    expect(isIgnorableRendererError(new Error('Model is disposed'))).toBe(true)
    expect(isIgnorableRendererError(new Error('TextModel got disposed'))).toBe(true)
    expect(isIgnorableRendererError(new Error('Attempting to use a disposed editor'))).toBe(true)
    expect(isIgnorableRendererError(new Error('InstantiationService has been disposed'))).toBe(true)
    expect(isIgnorableRendererError(undefined, 'Error: monaco.editor.create failed')).toBe(true)
    expect(
      isIgnorableRendererError(
        new Error('Something went wrong'),
        'at monaco-editor/esm/vs/editor/browser/widget/codeEditorWidget.js'
      )
    ).toBe(true)
  })

  it('does not ignore real renderer failures', () => {
    expect(isIgnorableRendererError(new Error("Cannot read properties of undefined (reading 'loadProjects')"))).toBe(false)
    expect(isIgnorableRendererError(new Error("Cannot read properties of undefined (reading 'onTasksRemoved')"))).toBe(false)
    expect(isIgnorableRendererError(undefined, 'Renderer crashed while rendering')).toBe(false)
  })
})

describe('shouldSkipRendererCrashScreen', () => {
  it('skips CrashScreen for ignorable errors and non-Error Monaco events', () => {
    expect(shouldSkipRendererCrashScreen(new Error('Canceled'))).toBe(true)
    expect(shouldSkipRendererCrashScreen(new Error('InstantiationService has been disposed'))).toBe(true)
    expect(shouldSkipRendererCrashScreen(undefined, 'ResizeObserver loop limit exceeded')).toBe(true)
    expect(shouldSkipRendererCrashScreen(undefined, 'Script error.')).toBe(true)
    expect(shouldSkipRendererCrashScreen({ type: 'error' }, 'monaco')).toBe(true)
  })

  it('does not skip CrashScreen for real Error instances', () => {
    expect(
      shouldSkipRendererCrashScreen(
        new Error("Cannot read properties of undefined (reading 'onTasksRemoved')")
      )
    ).toBe(false)
    expect(shouldSkipRendererCrashScreen(new Error('Renderer crashed while rendering'))).toBe(false)
  })
})
