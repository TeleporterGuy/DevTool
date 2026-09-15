import type { editor } from 'monaco-editor'
import type { AppConfig } from '../../shared/types'

export const EDITOR_FONT_SIZE_MIN = 8
export const EDITOR_FONT_SIZE_MAX = 32
export const EDITOR_TAB_SIZE_MIN = 1
export const EDITOR_TAB_SIZE_MAX = 8

const DEFAULT_EDITOR_FONT_SIZE = 14
const DEFAULT_EDITOR_TAB_SIZE = 4

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  toml: 'toml',
  xml: 'xml',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  r: 'r',
  lua: 'lua',
  dart: 'dart',
  graphql: 'graphql',
  scss: 'scss',
  less: 'less'
}

function clamp(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGE_MAP[ext] ?? 'plaintext'
}

export function buildMonacoEditorOptions(config: AppConfig): editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    fontFamily: config.editorFontFamily,
    fontSize: clamp(config.editorFontSize, DEFAULT_EDITOR_FONT_SIZE, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX),
    lineNumbers: config.editorLineNumbers,
    minimap: { enabled: config.editorMinimap },
    renderWhitespace: config.editorRenderWhitespace,
    tabSize: clamp(config.editorTabSize, DEFAULT_EDITOR_TAB_SIZE, EDITOR_TAB_SIZE_MIN, EDITOR_TAB_SIZE_MAX),
    wordWrap: config.editorWordWrap
  }
}

export function buildMonacoDiffOptions(config: AppConfig): editor.IStandaloneDiffEditorConstructionOptions {
  return {
    ...buildMonacoEditorOptions(config),
    ignoreTrimWhitespace: config.diffIgnoreTrimWhitespace,
    readOnly: true,
    renderSideBySide: config.diffRenderSideBySide
  }
}

/** Compact Monaco options for one notebook cell (no minimap). Height tracks content; the notebook pane scrolls. */
export const NOTEBOOK_CELL_EDITOR_MIN_HEIGHT = 48

/** Grow with Monaco content. No max — the outer notebook list is overflow-y-auto. */
export function notebookCellEditorHeight(contentHeight: number): number {
  const padded = (Number.isFinite(contentHeight) ? contentHeight : 0) + 4
  return Math.max(NOTEBOOK_CELL_EDITOR_MIN_HEIGHT, padded)
}

export function buildMonacoNotebookCellOptions(config: AppConfig): editor.IStandaloneEditorConstructionOptions {
  return {
    ...buildMonacoEditorOptions(config),
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    folding: false,
    renderLineHighlight: 'none',
    wordWrap: 'on',
    // Manual height from contentHeight. automaticLayout uses ResizeObserver and
    // can throw when several cell editors move in the DOM (move up/down).
    automaticLayout: false,
    scrollbar: {
      vertical: 'hidden',
      horizontal: 'auto',
      handleMouseWheel: false,
      alwaysConsumeMouseWheel: false
    }
  }
}
