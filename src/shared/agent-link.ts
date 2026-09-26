import { isAgentTabType } from './types'
import type { Tab } from './types'

/**
 * Agent context links (Phase 4.5), Cursor's Ctrl+L / Ctrl+Shift+L for any agent.
 *
 * Ctrl+L sends the selected lines themselves (a snippet): a header naming the
 * file, cell and lines, then the lines in a fenced block. Terminal agents (Claude
 * Code, Codex, Pi) fold a multi-line paste into one "[Pasted text]" chip, so the
 * input stays readable. Ctrl+Shift+L sends `@path`, which Claude Code expands into
 * the whole file and the others read as a path.
 *
 *   @src/foo.ts                                        whole file
 *   src/foo.ts (lines 10-24):  + fenced lines          selection
 *   analysis.ipynb (cell 4 of 9, id 3c8d9b5c, lines 3-5):  + fenced lines
 */
export interface AgentLinkTarget {
  /** Path as the agent should see it (workspace-relative, `/` separators). */
  path: string
  startLine?: number
  endLine?: number
  /** 1-based position of the notebook cell — always valid, even without stored ids. */
  cellNumber?: number
  /** How many cells the notebook has, so "cell 1 of 9" reads as 1-based. */
  cellCount?: number
  /** nbformat cell id, only when the file on disk stores it. */
  cellId?: string
  isDirectory?: boolean
}

function quotePath(path: string, isDirectory?: boolean): string {
  let p = path.replace(/\\/g, '/')
  if (isDirectory && !p.endsWith('/')) p += '/'
  return /\s/.test(p) ? `"${p}"` : p
}

function scopeLabel({ startLine, endLine, cellNumber, cellCount, cellId }: AgentLinkTarget): string {
  const parts: string[] = []
  if (cellNumber !== undefined) {
    const of = cellCount !== undefined ? ` of ${cellCount}` : ''
    parts.push(cellId ? `cell ${cellNumber}${of}, id ${cellId}` : `cell ${cellNumber}${of}`)
  } else if (cellId) {
    parts.push(`cell id ${cellId}`)
  }
  if (startLine !== undefined) {
    const end = endLine ?? startLine
    parts.push(end > startLine ? `lines ${startLine}-${end}` : `line ${startLine}`)
  }
  return parts.join(', ')
}

/** A pointer without content: `@path` for a whole file, `path (scope)` otherwise. */
export function formatAgentLink(target: AgentLinkTarget): string {
  const quoted = quotePath(target.path, target.isDirectory)
  const scope = scopeLabel(target)
  return scope ? `${quoted} (${scope}) ` : `@${quoted} `
}

/** Above this a snippet is not attached; a pointer (formatAgentLink) is sent instead. */
export const MAX_SNIPPET_CHARS = 20_000

/**
 * The selected lines with a header, as a fenced block, ending on a fresh line so
 * the question can follow. Null when too large to paste — send a pointer instead.
 */
export function formatAgentSnippet(target: AgentLinkTarget & { text: string; language?: string }): string | null {
  const body = target.text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (body.length > MAX_SNIPPET_CHARS) return null
  const quoted = quotePath(target.path)
  const scope = scopeLabel(target)
  // A fence longer than any backtick run in the text, so it cannot close early.
  const longestRun = Math.max(2, ...(body.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longestRun + 1)
  const header = scope ? `${quoted} (${scope}):` : `${quoted}:`
  return `${header}\n${fence}${target.language ?? ''}\n${body}\n${fence}\n`
}

/** Lines `startLine..endLine` (1-based, inclusive) of `text`. */
export function sliceLines(text: string, startLine: number, endLine: number): string {
  return text.split(/\r?\n/).slice(startLine - 1, endLine).join('\n')
}

/** A Monaco-style selection: 1-based lines and columns. */
export interface LineSelection {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/**
 * Lines a selection covers. An empty selection means the cursor line. A selection
 * that ends at column 1 of a later line (triple-click, or dragging to the start of
 * the next line) does not include that last line.
 */
export function selectionLines(sel: LineSelection): { startLine: number; endLine: number } {
  const startLine = Math.min(sel.startLineNumber, sel.endLineNumber)
  let endLine = Math.max(sel.startLineNumber, sel.endLineNumber)
  const endColumn = sel.endLineNumber >= sel.startLineNumber ? sel.endColumn : sel.startColumn
  if (endLine > startLine && endColumn === 1) endLine -= 1
  return { startLine, endLine }
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '')
}

function samePathPrefix(a: string, b: string, windows: boolean): boolean {
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The path an agent running in `agentCwd` should see for a workspace-relative
 * `fileRelPath`. Agent tabs normally run in the task workspace, so the relative
 * path is returned as is; an agent in a subfolder gets the prefix stripped, and
 * one outside the file's folder gets an absolute path.
 */
export function agentLinkPath(workspaceDir: string, fileRelPath: string, agentCwd?: string): string {
  const rel = fileRelPath.replace(/\\/g, '/').replace(/^\.?\/+/, '')
  if (!agentCwd) return rel
  const ws = normalizeDir(workspaceDir)
  const cwd = normalizeDir(agentCwd)
  const windows = /^[a-zA-Z]:\//.test(ws)
  if (samePathPrefix(cwd, ws, windows)) return rel

  const absolute = rel ? `${ws}/${rel}` : ws
  const prefix = `${cwd}/`
  if (absolute.length > prefix.length && samePathPrefix(absolute.slice(0, prefix.length), prefix, windows)) {
    return absolute.slice(prefix.length)
  }
  return absolute
}

export interface AgentTargetTask {
  tabs: { left: Tab[]; right: Tab[] }
  activeTab?: { left?: string | null; right?: string | null }
}

/**
 * Which agent tab of a task receives a link: the most recently focused one
 * (`recency`, newest first), else an agent tab that is active in either pane,
 * else the first agent tab in the left then right pane.
 */
export function pickAgentTarget(task: AgentTargetTask, recency: readonly string[] = []): Tab | null {
  const agentTabs = [...task.tabs.left, ...task.tabs.right].filter(t => isAgentTabType(t.type))
  if (agentTabs.length === 0) return null
  for (const id of recency) {
    const hit = agentTabs.find(t => t.id === id)
    if (hit) return hit
  }
  for (const id of [task.activeTab?.left, task.activeTab?.right]) {
    const hit = id ? agentTabs.find(t => t.id === id) : undefined
    if (hit) return hit
  }
  return agentTabs[0]
}
