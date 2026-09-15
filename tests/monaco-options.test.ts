import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/types'
import {
  buildMonacoDiffOptions,
  buildMonacoEditorOptions,
  buildMonacoNotebookCellOptions,
  getLanguageFromPath,
  notebookCellEditorHeight
} from '../src/renderer/components/monacoOptions'

describe('monacoOptions', () => {
  it('maps file extensions to Monaco languages', () => {
    expect(getLanguageFromPath('src/App.tsx')).toBe('typescript')
    expect(getLanguageFromPath('scripts/build.sh')).toBe('shell')
    expect(getLanguageFromPath('README.unknown')).toBe('plaintext')
  })

  it('builds editor options from config', () => {
    const options = buildMonacoEditorOptions({
      ...DEFAULT_CONFIG,
      editorFontFamily: 'JetBrains Mono',
      editorFontSize: 16,
      editorLineNumbers: 'relative',
      editorMinimap: true,
      editorRenderWhitespace: 'all',
      editorTabSize: 2,
      editorWordWrap: 'bounded'
    })

    expect(options).toMatchObject({
      automaticLayout: true,
      fontFamily: 'JetBrains Mono',
      fontSize: 16,
      lineNumbers: 'relative',
      renderWhitespace: 'all',
      tabSize: 2,
      wordWrap: 'bounded'
    })
    expect(options.minimap).toEqual({ enabled: true })
  })

  it('builds diff options from config', () => {
    const options = buildMonacoDiffOptions({
      ...DEFAULT_CONFIG,
      editorFontFamily: 'Iosevka',
      diffIgnoreTrimWhitespace: false,
      diffRenderSideBySide: false
    })

    expect(options).toMatchObject({
      fontFamily: 'Iosevka',
      ignoreTrimWhitespace: false,
      readOnly: true,
      renderSideBySide: false
    })
  })

  it('builds compact notebook cell options without a minimap', () => {
    const options = buildMonacoNotebookCellOptions({
      ...DEFAULT_CONFIG,
      editorMinimap: true,
      editorFontFamily: 'JetBrains Mono'
    })
    expect(options.minimap).toEqual({ enabled: false })
    expect(options.scrollBeyondLastLine).toBe(false)
    expect(options.fontFamily).toBe('JetBrains Mono')
    expect(options.wordWrap).toBe('on')
    expect(options.scrollbar).toMatchObject({ vertical: 'hidden' })
  })

  it('grows notebook cell height with content and does not cap at 520', () => {
    expect(notebookCellEditorHeight(20)).toBe(48)
    expect(notebookCellEditorHeight(100)).toBe(104)
    expect(notebookCellEditorHeight(800)).toBe(804)
  })
})
