/**
 * nbformat v4 notebooks used by the in-app editor (Phase 4).
 * Parse/serialize stay in shared so renderer, main, and tests use one shape.
 */

import {
  lastPathSegment,
  listedCondaEnvForSelection,
  type CondaEnvInfo,
  type ProjectCondaSelection
} from './conda'

export const NOTEBOOK_NBFORMAT = 4
export const NOTEBOOK_NBFORMAT_MINOR = 5

export type NotebookCellType = 'code' | 'markdown' | 'raw'

export type NotebookStreamName = 'stdout' | 'stderr'

export type NotebookOutput =
  | { type: 'stream'; name: NotebookStreamName; text: string }
  | {
      type: 'execute_result'
      data: Record<string, string>
      executionCount: number | null
      metadata?: Record<string, unknown>
    }
  | { type: 'display_data'; data: Record<string, string>; metadata?: Record<string, unknown> }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] }
  | { type: 'unknown'; raw: Record<string, unknown> }

export interface NotebookCell {
  id: string
  cellType: NotebookCellType
  source: string
  outputs: NotebookOutput[]
  executionCount: number | null
  metadata: Record<string, unknown>
}

export interface NotebookDocument {
  nbformat: number
  nbformatMinor: number
  metadata: Record<string, unknown>
  cells: NotebookCell[]
}

/** Events the Python jupyter_client helper writes as JSON lines. */
export type NotebookKernelEvent =
  | { event: 'ready'; kernel_pid?: number }
  | { event: 'status'; execution_state: 'starting' | 'idle' | 'busy' | 'dead' }
  | { event: 'stream'; id: string; cellId?: string; name: NotebookStreamName; text: string }
  | { event: 'execute_result'; id: string; cellId?: string; data: Record<string, unknown>; execution_count?: number }
  | { event: 'display_data'; id: string; cellId?: string; data: Record<string, unknown> }
  | { event: 'error'; id: string; cellId?: string; ename: string; evalue: string; traceback: string[] }
  | { event: 'execute_reply'; id: string; cellId?: string; status: 'ok' | 'error' | 'abort'; execution_count?: number }
  | { event: 'fail'; code: string; message: string }
  | { event: 'dead'; message?: string }

/** Keep in sync with resources/notebook-kernel.py. */
export const NOTEBOOK_STREAM_CHAR_LIMIT = 200_000
export const NOTEBOOK_MIME_CHAR_LIMIT = 1_500_000
export const NOTEBOOK_TRUNCATED_MARKER = '\n[truncated]\n'
export const NOTEBOOK_PNG_OMITTED = '[truncated: image/png omitted (too large)]'
/**
 * Max cell source length JSON'd to the jupyter_client helper.
 * 1_000_000 chars (~1 MB) is well above normal notebooks; oversize is
 * rejected with an error, not truncated.
 */
export const NOTEBOOK_EXECUTE_CHAR_LIMIT = 1_000_000

export type NotebookKernelStatus = 'starting' | 'idle' | 'busy' | 'dead' | 'error'

export const NOTEBOOK_ERROR_NO_CONDA =
  'Pick a conda environment in the notebook toolbar, or in Project Settings. Notebooks run Python from that env.'

export const NOTEBOOK_ERROR_NO_PYTHON =
  'That conda env has no python executable. Pick another env, or repair this one.'

export const NOTEBOOK_ERROR_REMOTE =
  'Native notebooks are local-only in this version. Open the .ipynb on a local project.'

export const NOTEBOOK_ERROR_SHELL_PROJECT =
  'Notebooks need a local project with a conda env. Shell-command projects have no local Python.'

export const NOTEBOOK_ERROR_MISSING_JUPYTER =
  'Install jupyter_client and ipykernel in the project conda env, then Restart kernel.\n  conda install ipykernel jupyter_client'

export const NOTEBOOK_ERROR_CWD =
  'Notebook kernel cwd is outside this project.'

export const NOTEBOOK_ERROR_STALE_CONDA =
  "This notebook's saved conda env is not in the current conda list. Pick a listed env, then Restart kernel."

export const NOTEBOOK_ERROR_EXECUTE_TOO_LARGE =
  `Cell is too large to execute (limit is ${NOTEBOOK_EXECUTE_CHAR_LIMIT} characters).`

/** True when cell source must not be sent to the helper. */
export function notebookExecuteTooLarge(code: string): boolean {
  return code.length > NOTEBOOK_EXECUTE_CHAR_LIMIT
}

export function notebookExecuteTooLargeMessage(length: number): string {
  return `Cell is too large to execute (${length} characters; limit is ${NOTEBOOK_EXECUTE_CHAR_LIMIT}).`
}

/** Optional per-notebook conda override sent on kernel start/restart. */
export type NotebookKernelCondaOverride = { name?: string; prefix?: string }

export function notebookCondaEnvFromMetadata(
  metadata: Record<string, unknown> | undefined
): ProjectCondaSelection | null {
  const devtool = asRecord(metadata?.devtool)
  if (!devtool) return null
  const conda = asRecord(devtool.condaEnv)
  if (!conda) return null
  const name = typeof conda.name === 'string' ? conda.name.trim() : ''
  const prefix = typeof conda.prefix === 'string' ? conda.prefix.trim() : ''
  if (!name && !prefix) return null
  return { condaEnvName: name || undefined, condaEnvPrefix: prefix || undefined }
}

/** Write or clear `metadata.devtool.condaEnv` `{ name, prefix }`. */
export function setNotebookCondaEnvMetadata(
  doc: NotebookDocument,
  env: ProjectCondaSelection | null
): NotebookDocument {
  const metadata = { ...doc.metadata }
  const devtool = { ...(asRecord(metadata.devtool) ?? {}) }
  const name = env?.condaEnvName?.trim() ?? ''
  const prefix = env?.condaEnvPrefix?.trim() ?? ''
  if (!name && !prefix) {
    delete devtool.condaEnv
    if (Object.keys(devtool).length === 0) delete metadata.devtool
    else metadata.devtool = devtool
    return { ...doc, metadata }
  }
  metadata.devtool = {
    ...devtool,
    condaEnv: {
      ...(name ? { name } : {}),
      ...(prefix ? { prefix } : {})
    }
  }
  return { ...doc, metadata }
}

/** Override wins; otherwise the project env (notebook default). */
export function notebookKernelCondaSelection(
  override: ProjectCondaSelection | null | undefined,
  project: ProjectCondaSelection
): ProjectCondaSelection {
  if (override?.condaEnvName?.trim() || override?.condaEnvPrefix?.trim()) {
    return {
      condaEnvName: override.condaEnvName?.trim() || undefined,
      condaEnvPrefix: override.condaEnvPrefix?.trim() || undefined
    }
  }
  return {
    condaEnvName: project.condaEnvName?.trim() || undefined,
    condaEnvPrefix: project.condaEnvPrefix?.trim() || undefined
  }
}

export function notebookCondaOverridePayload(
  override: ProjectCondaSelection | null | undefined
): NotebookKernelCondaOverride | undefined {
  const name = override?.condaEnvName?.trim() ?? ''
  const prefix = override?.condaEnvPrefix?.trim() ?? ''
  if (!name && !prefix) return undefined
  return {
    ...(name ? { name } : {}),
    ...(prefix ? { prefix } : {})
  }
}

/** Closed-field / `<option value="">` text: env name first, then `(project default)`. */
export function notebookProjectDefaultOptionLabel(projectEnvLabel: string | null | undefined): string {
  const name = projectEnvLabel?.trim() ?? ''
  return name ? `${name} (project default)` : 'Project default'
}

/**
 * Visible env label for the combined kernel/env control.
 * Override shows just the env name; project default adds `(project default)`.
 */
export function notebookKernelEnvControlLabel(
  usingOverride: boolean,
  envLabel: string | null | undefined,
  projectEnvLabel: string | null | undefined
): string {
  if (usingOverride) {
    const name = envLabel?.trim() ?? ''
    return name || 'Untitled'
  }
  return notebookProjectDefaultOptionLabel(projectEnvLabel)
}

export function notebookKernelStatusWord(status: NotebookKernelStatus): string {
  if (status === 'starting' || status === 'busy' || status === 'dead' || status === 'error') {
    return status
  }
  return 'idle'
}

/** Tooltip / aria-label: status is not shown in the chrome, only here. */
export function notebookKernelEnvControlTitle(
  status: NotebookKernelStatus,
  controlLabel: string
): string {
  return `Kernel ${notebookKernelStatusWord(status)} — ${controlLabel}. Click to change.`
}

/**
 * Live resolve result, or the saved name/prefix so spawn can fail closed
 * (stale override must not fall back to the project env).
 * Used for the project-default path only. Notebook overrides must go through
 * `resolveNotebookKernelCondaEnv` so an unlisted prefix cannot spawn.
 */
export function condaEnvInfoForNotebookSpawn(
  selection: ProjectCondaSelection,
  resolved: CondaEnvInfo | null
): CondaEnvInfo | null {
  if (resolved) return resolved
  const prefix = selection.condaEnvPrefix?.trim() ?? ''
  const name = selection.condaEnvName?.trim() ?? ''
  if (!prefix && !name) return null
  return { name: name || lastPathSegment(prefix), prefix }
}

export type NotebookKernelCondaResolve =
  | { ok: true; env: CondaEnvInfo | null }
  | { ok: false; code: 'stale-conda'; error: string }

/**
 * Override: match the live conda list only. Unlisted name/prefix fails closed
 * (do not spawn that folder's python.exe, do not fall back to the project env).
 * No override: project default, including `condaEnvInfoForNotebookSpawn`.
 */
export function resolveNotebookKernelCondaEnv(
  override: ProjectCondaSelection | null | undefined,
  project: ProjectCondaSelection,
  listedEnvs: CondaEnvInfo[],
  projectResolved: CondaEnvInfo | null,
  platform: string
): NotebookKernelCondaResolve {
  const hasOverride = !!(override?.condaEnvName?.trim() || override?.condaEnvPrefix?.trim())
  if (hasOverride) {
    const listed = listedCondaEnvForSelection(listedEnvs, {
      condaEnvName: override?.condaEnvName,
      condaEnvPrefix: override?.condaEnvPrefix
    }, platform)
    if (!listed) {
      return { ok: false, code: 'stale-conda', error: NOTEBOOK_ERROR_STALE_CONDA }
    }
    return { ok: true, env: listed }
  }
  const selection = notebookKernelCondaSelection(null, project)
  return { ok: true, env: condaEnvInfoForNotebookSpawn(selection, projectResolved) }
}

export function isNotebookFile(filePath?: string | null): boolean {
  if (!filePath) return false
  return /\.ipynb$/i.test(filePath)
}

export function newCellId(): string {
  return `cell-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export function emptyNotebook(): NotebookDocument {
  return {
    nbformat: NOTEBOOK_NBFORMAT,
    nbformatMinor: NOTEBOOK_NBFORMAT_MINOR,
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3'
      },
      language_info: { name: 'python' }
    },
    cells: [emptyCell('code')]
  }
}

export function emptyCell(cellType: NotebookCellType = 'code'): NotebookCell {
  return {
    id: newCellId(),
    cellType,
    source: '',
    outputs: [],
    executionCount: null,
    metadata: {}
  }
}

/**
 * JupyterLab collapse flags live under `cell.metadata.jupyter`.
 * Collapsed in DevTool means `source_hidden` is true (editor/source hidden).
 * `outputs_hidden` is ignored — results stay visible under the header.
 * New cells omit these keys (expanded).
 */
export function isNotebookCellCollapsed(cell: Pick<NotebookCell, 'metadata'>): boolean {
  const jupyter = asRecord(cell.metadata.jupyter)
  if (!jupyter) return false
  return jupyter.source_hidden === true
}

/** First non-empty source line, for the collapsed-cell header preview. */
export function notebookCellSourcePreview(source: string): string {
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * Set or clear Jupyter hide flags without dropping other `jupyter` / cell metadata keys.
 * Collapse sets `source_hidden` and clears `outputs_hidden` so outputs stay shown.
 * Expand clears both flags and removes an empty `jupyter` object.
 */
export function setCellCollapsedMetadata(
  metadata: Record<string, unknown>,
  collapsed: boolean
): Record<string, unknown> {
  const next = { ...metadata }
  const jupyter = { ...(asRecord(next.jupyter) ?? {}) }
  if (collapsed) {
    jupyter.source_hidden = true
    delete jupyter.outputs_hidden
    next.jupyter = jupyter
    return next
  }
  delete jupyter.source_hidden
  delete jupyter.outputs_hidden
  if (Object.keys(jupyter).length === 0) delete next.jupyter
  else next.jupyter = jupyter
  return next
}

export function setNotebookCellCollapsed(
  doc: NotebookDocument,
  cellId: string,
  collapsed: boolean
): NotebookDocument {
  return {
    ...doc,
    cells: doc.cells.map((cell) => (
      cell.id === cellId
        ? { ...cell, metadata: setCellCollapsedMetadata(cell.metadata, collapsed) }
        : cell
    ))
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

/** Jupyter stores source/text as a string or an array of line strings. */
export function joinNotebookText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((line) => (typeof line === 'string' ? line : '')).join('')
  }
  return ''
}

/**
 * Split a buffer into Jupyter line arrays: every line except the last keeps its `\n`.
 */
export function splitNotebookText(source: string): string[] {
  if (source === '') return []
  const parts = source.split('\n')
  return parts.map((line, index) => (index === parts.length - 1 ? line : `${line}\n`))
}

export function normalizeMimeBundle(data: unknown): Record<string, string> {
  const record = asRecord(data)
  if (!record) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') out[key] = value
    else if (Array.isArray(value)) out[key] = value.map((line) => (typeof line === 'string' ? line : '')).join('')
  }
  return out
}

function parseOutput(raw: unknown): NotebookOutput {
  const record = asRecord(raw)
  if (!record) return { type: 'unknown', raw: {} }
  const outputType = record.output_type
  if (outputType === 'stream') {
    const name = record.name === 'stderr' ? 'stderr' : 'stdout'
    return { type: 'stream', name, text: joinNotebookText(record.text) }
  }
  if (outputType === 'execute_result') {
    const count = typeof record.execution_count === 'number' ? record.execution_count : null
    return {
      type: 'execute_result',
      data: normalizeMimeBundle(record.data),
      executionCount: count,
      metadata: asRecord(record.metadata) ?? undefined
    }
  }
  if (outputType === 'display_data') {
    return {
      type: 'display_data',
      data: normalizeMimeBundle(record.data),
      metadata: asRecord(record.metadata) ?? undefined
    }
  }
  if (outputType === 'error') {
    const traceback = Array.isArray(record.traceback)
      ? record.traceback.filter((line): line is string => typeof line === 'string')
      : []
    return {
      type: 'error',
      ename: typeof record.ename === 'string' ? record.ename : 'Error',
      evalue: typeof record.evalue === 'string' ? record.evalue : '',
      traceback
    }
  }
  return { type: 'unknown', raw: record }
}

function serializeOutput(output: NotebookOutput): Record<string, unknown> {
  if (output.type === 'stream') {
    return { output_type: 'stream', name: output.name, text: splitNotebookText(output.text) }
  }
  if (output.type === 'execute_result') {
    return {
      output_type: 'execute_result',
      execution_count: output.executionCount,
      data: output.data,
      metadata: output.metadata ?? {}
    }
  }
  if (output.type === 'display_data') {
    return {
      output_type: 'display_data',
      data: output.data,
      metadata: output.metadata ?? {}
    }
  }
  if (output.type === 'error') {
    return {
      output_type: 'error',
      ename: output.ename,
      evalue: output.evalue,
      traceback: output.traceback
    }
  }
  return output.raw
}

function parseCellType(value: unknown): NotebookCellType {
  if (value === 'markdown' || value === 'raw' || value === 'code') return value
  return 'code'
}

function parseCell(raw: unknown, index: number): NotebookCell {
  const record = asRecord(raw) ?? {}
  const cellType = parseCellType(record.cell_type)
  const id = typeof record.id === 'string' && record.id.trim() ? record.id : `cell-${index}-${newCellId()}`
  const executionCount = typeof record.execution_count === 'number' ? record.execution_count : null
  return {
    id,
    cellType,
    source: joinNotebookText(record.source),
    outputs: cellType === 'code' && Array.isArray(record.outputs)
      ? record.outputs.map(parseOutput)
      : [],
    executionCount: cellType === 'code' ? executionCount : null,
    metadata: asRecord(record.metadata) ?? {}
  }
}

/**
 * Parse a `.ipynb` file. An empty file becomes a new one-cell notebook so
 * File-tree “New file” → `foo.ipynb` is immediately usable.
 */
export function parseNotebook(text: string): NotebookDocument {
  const trimmed = text.trim()
  if (trimmed === '') return emptyNotebook()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('This .ipynb file is not valid JSON.')
  }

  const record = asRecord(parsed)
  if (!record) throw new Error('This .ipynb file is not a notebook object.')

  const nbformat = record.nbformat
  if (nbformat !== NOTEBOOK_NBFORMAT) {
    throw new Error(`Unsupported notebook format (nbformat ${String(nbformat)}). DevTool opens nbformat 4.`)
  }

  const cellsRaw = Array.isArray(record.cells) ? record.cells : []
  const cells = cellsRaw.map(parseCell)
  return {
    nbformat: NOTEBOOK_NBFORMAT,
    nbformatMinor: typeof record.nbformat_minor === 'number' ? record.nbformat_minor : NOTEBOOK_NBFORMAT_MINOR,
    metadata: asRecord(record.metadata) ?? {},
    cells: cells.length > 0 ? cells : [emptyCell('code')]
  }
}

export function serializeNotebook(doc: NotebookDocument): string {
  const cells = doc.cells.map((cell) => {
    const raw: Record<string, unknown> = {
      id: cell.id,
      cell_type: cell.cellType,
      metadata: cell.metadata,
      source: splitNotebookText(cell.source)
    }
    if (cell.cellType === 'code') {
      raw.execution_count = cell.executionCount
      raw.outputs = cell.outputs.map(serializeOutput)
    }
    return raw
  })
  const payload = {
    nbformat: doc.nbformat || NOTEBOOK_NBFORMAT,
    nbformat_minor: doc.nbformatMinor || NOTEBOOK_NBFORMAT_MINOR,
    metadata: doc.metadata,
    cells
  }
  return `${JSON.stringify(payload, null, 1)}\n`
}

export function addCellAt(doc: NotebookDocument, index: number, cellType: NotebookCellType): NotebookDocument {
  const clamped = Math.max(0, Math.min(index, doc.cells.length))
  const cells = [...doc.cells]
  cells.splice(clamped, 0, emptyCell(cellType))
  return { ...doc, cells }
}

export function deleteCellAt(doc: NotebookDocument, index: number): NotebookDocument {
  if (doc.cells.length <= 1) {
    return { ...doc, cells: [emptyCell('code')] }
  }
  if (index < 0 || index >= doc.cells.length) return doc
  return { ...doc, cells: doc.cells.filter((_, i) => i !== index) }
}

export function changeCellTypeAt(
  doc: NotebookDocument,
  index: number,
  cellType: NotebookCellType
): NotebookDocument {
  const cell = doc.cells[index]
  if (!cell || cell.cellType === cellType) return doc
  const next: NotebookCell = {
    ...cell,
    cellType,
    outputs: cellType === 'code' ? cell.outputs : [],
    executionCount: cellType === 'code' ? cell.executionCount : null
  }
  return { ...doc, cells: doc.cells.map((item, i) => (i === index ? next : item)) }
}

export function moveCell(doc: NotebookDocument, from: number, to: number): NotebookDocument {
  if (from === to) return doc
  if (from < 0 || from >= doc.cells.length) return doc
  if (to < 0 || to >= doc.cells.length) return doc
  const cells = [...doc.cells]
  const [cell] = cells.splice(from, 1)
  if (!cell) return doc
  cells.splice(to, 0, cell)
  return { ...doc, cells }
}

/** Toolbar up/down: resolve the live index so a stale row index cannot splice holes. */
export function moveCellById(
  doc: NotebookDocument,
  cellId: string,
  direction: -1 | 1
): NotebookDocument {
  const from = doc.cells.findIndex((cell) => cell.id === cellId)
  if (from < 0) return doc
  return moveCell(doc, from, from + direction)
}

export function updateCellSource(doc: NotebookDocument, cellId: string, source: string): NotebookDocument {
  return {
    ...doc,
    cells: doc.cells.map((cell) => (cell.id === cellId ? { ...cell, source } : cell))
  }
}

export function replaceCellOutputs(
  doc: NotebookDocument,
  cellId: string,
  outputs: NotebookOutput[],
  executionCount?: number | null
): NotebookDocument {
  return {
    ...doc,
    cells: doc.cells.map((cell) => {
      if (cell.id !== cellId) return cell
      return {
        ...cell,
        outputs,
        executionCount: executionCount === undefined ? cell.executionCount : executionCount
      }
    })
  }
}

export function clearAllOutputs(doc: NotebookDocument): NotebookDocument {
  return {
    ...doc,
    cells: doc.cells.map((cell) => (
      cell.cellType === 'code' ? { ...cell, outputs: [], executionCount: null } : cell
    ))
  }
}

export function truncateText(
  text: string,
  limit: number,
  marker: string = NOTEBOOK_TRUNCATED_MARKER
): string {
  if (text.length <= limit) return text
  const keep = Math.max(0, limit - marker.length)
  return text.slice(0, keep) + marker
}

export function truncateMimeBundle(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let omittedPng = false
  for (const [key, value] of Object.entries(data)) {
    const text = typeof value === 'string' ? value : joinNotebookText(value)
    if (key === 'image/png' && text.length > NOTEBOOK_MIME_CHAR_LIMIT) {
      omittedPng = true
      continue
    }
    out[key] = truncateText(text, NOTEBOOK_MIME_CHAR_LIMIT)
  }
  if (omittedPng) {
    const existing = out['text/plain']
    const note = typeof existing === 'string' && existing.length > 0
      ? `${existing}\n${NOTEBOOK_PNG_OMITTED}`
      : NOTEBOOK_PNG_OMITTED
    out['text/plain'] = note
  }
  return out
}

export function truncateKernelEvent(event: NotebookKernelEvent): NotebookKernelEvent {
  if (event.event === 'stream') {
    return { ...event, text: truncateText(event.text, NOTEBOOK_STREAM_CHAR_LIMIT) }
  }
  if (event.event === 'execute_result' || event.event === 'display_data') {
    return { ...event, data: truncateMimeBundle(event.data) }
  }
  if (event.event === 'error') {
    const joined = event.traceback.join('\n')
    if (joined.length > NOTEBOOK_STREAM_CHAR_LIMIT) {
      return { ...event, traceback: [truncateText(joined, NOTEBOOK_STREAM_CHAR_LIMIT)] }
    }
  }
  return event
}

/** Merge consecutive stdout/stderr streams so the UI does not flicker a node per chunk. */
export function appendOutput(outputs: NotebookOutput[], next: NotebookOutput): NotebookOutput[] {
  if (next.type === 'stream' && outputs.length > 0) {
    const last = outputs[outputs.length - 1]
    if (last.type === 'stream' && last.name === next.name) {
      const merged = last.text + next.text
      return [...outputs.slice(0, -1), { ...last, text: truncateText(merged, NOTEBOOK_STREAM_CHAR_LIMIT) }]
    }
  }
  if (next.type === 'stream') {
    return [...outputs, { ...next, text: truncateText(next.text, NOTEBOOK_STREAM_CHAR_LIMIT) }]
  }
  return [...outputs, next]
}

export function mimePlainText(data: Record<string, string>): string | null {
  const plain = data['text/plain']
  return plain == null || plain === '' ? null : plain
}

export function mimePng(data: Record<string, string>): string | null {
  const png = data['image/png']
  return png && png.length > 0 ? png : null
}

/**
 * Apply one kernel event to a cell's outputs. Returns null when the event is
 * status/reply and does not change outputs (caller still uses execute_reply
 * for execution_count / running).
 */
export function applyKernelEventToOutputs(
  outputs: NotebookOutput[],
  event: NotebookKernelEvent
): NotebookOutput[] | null {
  if (event.event === 'stream') {
    return appendOutput(outputs, { type: 'stream', name: event.name, text: event.text })
  }
  if (event.event === 'execute_result') {
    const data = normalizeMimeBundle(event.data)
    return appendOutput(outputs, {
      type: 'execute_result',
      data,
      executionCount: typeof event.execution_count === 'number' ? event.execution_count : null
    })
  }
  if (event.event === 'display_data') {
    return appendOutput(outputs, {
      type: 'display_data',
      data: normalizeMimeBundle(event.data)
    })
  }
  if (event.event === 'error') {
    return appendOutput(outputs, {
      type: 'error',
      ename: event.ename,
      evalue: event.evalue,
      traceback: event.traceback
    })
  }
  return null
}

function optionalCellId(record: Record<string, unknown>): string | undefined {
  return typeof record.cellId === 'string' && record.cellId.length > 0 ? record.cellId : undefined
}

function requireRequestId(record: Record<string, unknown>): string | null {
  return typeof record.id === 'string' && record.id.length > 0 ? record.id : null
}

/**
 * Parse one helper stdout line. Unknown events and missing required fields are ignored.
 */
export function parseKernelEventLine(line: string): NotebookKernelEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  const record = asRecord(parsed)
  if (!record || typeof record.event !== 'string') return null

  switch (record.event) {
    case 'ready': {
      const pid = record.kernel_pid
      if (pid === undefined || pid === null) return { event: 'ready' }
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
      return { event: 'ready', kernel_pid: pid }
    }
    case 'status': {
      const state = record.execution_state
      if (state !== 'starting' && state !== 'idle' && state !== 'busy' && state !== 'dead') return null
      return { event: 'status', execution_state: state }
    }
    case 'stream': {
      const id = requireRequestId(record)
      if (!id) return null
      if (record.name !== 'stdout' && record.name !== 'stderr') return null
      if (typeof record.text !== 'string') return null
      return truncateKernelEvent({
        event: 'stream',
        id,
        cellId: optionalCellId(record),
        name: record.name,
        text: record.text
      })
    }
    case 'execute_result': {
      const id = requireRequestId(record)
      if (!id) return null
      const data = asRecord(record.data)
      if (!data) return null
      const count = record.execution_count
      return truncateKernelEvent({
        event: 'execute_result',
        id,
        cellId: optionalCellId(record),
        data,
        execution_count: typeof count === 'number' ? count : undefined
      })
    }
    case 'display_data': {
      const id = requireRequestId(record)
      if (!id) return null
      const data = asRecord(record.data)
      if (!data) return null
      return truncateKernelEvent({
        event: 'display_data',
        id,
        cellId: optionalCellId(record),
        data
      })
    }
    case 'error': {
      const id = requireRequestId(record)
      if (!id) return null
      if (typeof record.ename !== 'string' || typeof record.evalue !== 'string') return null
      const traceback = Array.isArray(record.traceback)
        ? record.traceback.filter((line): line is string => typeof line === 'string')
        : []
      return truncateKernelEvent({
        event: 'error',
        id,
        cellId: optionalCellId(record),
        ename: record.ename,
        evalue: record.evalue,
        traceback
      })
    }
    case 'execute_reply': {
      const id = requireRequestId(record)
      if (!id) return null
      if (record.status !== 'ok' && record.status !== 'error' && record.status !== 'abort') return null
      const count = record.execution_count
      return {
        event: 'execute_reply',
        id,
        cellId: optionalCellId(record),
        status: record.status,
        execution_count: typeof count === 'number' ? count : undefined
      }
    }
    case 'fail': {
      if (typeof record.code !== 'string' || typeof record.message !== 'string') return null
      return { event: 'fail', code: record.code, message: record.message }
    }
    case 'dead': {
      const message = record.message
      if (message !== undefined && typeof message !== 'string') return null
      return { event: 'dead', message: typeof message === 'string' ? message : undefined }
    }
    default:
      return null
  }
}
