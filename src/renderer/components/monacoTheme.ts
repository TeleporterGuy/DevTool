import type { Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

// Warm Monaco themes matching the app palette (styles.css @theme).
// Chrome colors stay on the paper/ink surfaces. Syntax rules follow the
// highlight.js tokens in styles.css (.note-preview .hljs-*) so an idle
// notebook cell and the focused Monaco editor read the same — especially
// parameters/variables in blue, not default foreground.
export const MONACO_THEME_DARK = 'devtool-dark'
export const MONACO_THEME_LIGHT = 'devtool-light'

/** Monaco wants hex without '#'. Same values as .note-preview .hljs-* (dark). */
export const MONACO_TOKEN_RULES_DARK: editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6a9955' },
  { token: 'string', foreground: 'ce9178' },
  { token: 'string.escape', foreground: 'ce9178' },
  { token: 'keyword', foreground: 'c586c0' },
  { token: 'keyword.flow', foreground: 'c586c0' },
  { token: 'number', foreground: 'b5cea8' },
  { token: 'type', foreground: '4ec9b0' },
  { token: 'type.identifier', foreground: '4ec9b0' },
  { token: 'class', foreground: '4ec9b0' },
  { token: 'function', foreground: 'dcdcaa' },
  { token: 'member', foreground: 'dcdcaa' },
  // Python monarch uses `identifier` for names (params, locals, attributes).
  { token: 'identifier', foreground: '9cdcfe' },
  { token: 'variable', foreground: '9cdcfe' },
  { token: 'variable.parameter', foreground: '9cdcfe' },
  { token: 'parameter', foreground: '9cdcfe' },
  { token: 'property', foreground: '9cdcfe' },
  { token: 'tag', foreground: '569cd6' },
  { token: 'metatag', foreground: '569cd6' },
  { token: 'attribute.name', foreground: '9cdcfe' }
]

/** Same mapping as .theme-light .note-preview .hljs-* */
export const MONACO_TOKEN_RULES_LIGHT: editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '008000' },
  { token: 'string', foreground: 'a31515' },
  { token: 'string.escape', foreground: 'a31515' },
  { token: 'keyword', foreground: 'af00db' },
  { token: 'keyword.flow', foreground: 'af00db' },
  { token: 'number', foreground: '098658' },
  { token: 'type', foreground: '267f99' },
  { token: 'type.identifier', foreground: '267f99' },
  { token: 'class', foreground: '267f99' },
  { token: 'function', foreground: '795e26' },
  { token: 'member', foreground: '795e26' },
  { token: 'identifier', foreground: '001080' },
  { token: 'variable', foreground: '001080' },
  { token: 'variable.parameter', foreground: '001080' },
  { token: 'parameter', foreground: '001080' },
  { token: 'property', foreground: '001080' },
  { token: 'tag', foreground: '800000' },
  { token: 'metatag', foreground: '0000ff' },
  { token: 'attribute.name', foreground: '001080' }
]

let defined = false

export function defineMonacoThemes(monaco: Monaco): void {
  if (defined) return
  defined = true

  monaco.editor.defineTheme(MONACO_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: MONACO_TOKEN_RULES_DARK,
    colors: {
      'editor.background': '#1d1b18',
      'editor.foreground': '#f0ece4',
      'editorLineNumber.foreground': '#7c766c',
      'editorLineNumber.activeForeground': '#9b948a',
      'editor.selectionBackground': '#c7925744',
      'editor.inactiveSelectionBackground': '#c7925726',
      'editor.lineHighlightBackground': '#211f1b',
      'editorGutter.background': '#1d1b18',
      'editorWidget.background': '#2a2722',
      'editorWidget.border': '#35312b',
      'editorCursor.foreground': '#c79257',
      'scrollbarSlider.background': '#f0ece42e',
      'scrollbarSlider.hoverBackground': '#f0ece440',
      'scrollbarSlider.activeBackground': '#f0ece45c',
      'minimap.background': '#1d1b18'
    }
  })

  monaco.editor.defineTheme(MONACO_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: MONACO_TOKEN_RULES_LIGHT,
    colors: {
      'editor.background': '#faf8f3',
      'editor.foreground': '#23211d',
      'editorLineNumber.foreground': '#a39c90',
      'editorLineNumber.activeForeground': '#7c766c',
      'editor.selectionBackground': '#9a623029',
      'editor.inactiveSelectionBackground': '#9a623014',
      'editor.lineHighlightBackground': '#f6f4ef',
      'editorGutter.background': '#faf8f3',
      'editorWidget.background': '#fffdf9',
      'editorWidget.border': '#e0dccf',
      'editorCursor.foreground': '#9a6230',
      'scrollbarSlider.background': '#23211d2e',
      'scrollbarSlider.hoverBackground': '#23211d40',
      'scrollbarSlider.activeBackground': '#23211d5c',
      'minimap.background': '#faf8f3'
    }
  })
}

export function monacoThemeFor(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? MONACO_THEME_DARK : MONACO_THEME_LIGHT
}
