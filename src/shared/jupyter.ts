/**
 * Pure JupyterLab helpers (URL parse, reuse, error copy).
 * Main owns the process; the renderer only opens a browser tab at the URL.
 */

import path from 'path'
import { joinWorkspaceDir } from './workspace-path'

export const JUPYTER_LAB_TITLE = 'JupyterLab'

export type JupyterOpenOk = {
  ok: true
  url: string
  reused: boolean
  port: number
}

export type JupyterOpenErr = {
  ok: false
  error: string
}

export type JupyterOpenResult = JupyterOpenOk | JupyterOpenErr

export type JupyterServerKey = {
  projectId: string
  cwd: string
  condaPrefix: string
}

export const JUPYTER_ERRORS = {
  notLocal:
    'JupyterLab only runs for local projects. Remote SSH / SOCKS Jupyter is not in this version.',
  noConda: 'Pick a conda env in Project Settings before opening JupyterLab.',
  condaMissing:
    'The saved conda env is missing or no longer valid. Pick one in Project Settings.',
  noFolder: 'This project has no folder to start JupyterLab in.',
  noTask: 'Create a task in this project first so JupyterLab can open in a browser tab.',
  noProject: 'Select a local project first.',
  noPython: (prefix: string) =>
    `The conda env at ${prefix} has no python executable.`,
  noJupyterlab: (name: string) =>
    `JupyterLab is not installed in the "${name}" conda env. In that env run: pip install jupyterlab  (or conda install jupyterlab)`,
  portBind: (port: number) =>
    `Could not bind JupyterLab to 127.0.0.1:${port}.`,
  startFailed: (detail: string) =>
    detail
      ? `JupyterLab failed to start.\n${detail}`
      : 'JupyterLab failed to start.',
  startTimeout: 'JupyterLab started but did not become ready in time.',
  cwdNotAllowed:
    'JupyterLab can only start in this project folder or one of its worktrees.'
}

/** Folders compared for reuse: strip a trailing slash; Windows is case-insensitive. */
export function normalizeJupyterCwd(cwd: string, platform: NodeJS.Platform): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '')
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

export function sameJupyterKey(
  running: JupyterServerKey,
  wanted: JupyterServerKey,
  platform: NodeJS.Platform
): boolean {
  if (running.projectId !== wanted.projectId) return false
  if (normalizeJupyterCwd(running.cwd, platform) !== normalizeJupyterCwd(wanted.cwd, platform)) {
    return false
  }
  const a = running.condaPrefix.trim()
  const b = wanted.condaPrefix.trim()
  if (platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

/**
 * Reuse a live server for the same project + folder + conda env.
 * `stillOwned` is the ChildProcess we spawned (not a raw pid lookup — PIDs get reused).
 */
export function canReuseJupyterServer(
  running: (JupyterServerKey & { pid: number }) | null | undefined,
  wanted: JupyterServerKey,
  platform: NodeJS.Platform,
  stillOwned: boolean
): boolean {
  if (!running) return false
  if (!sameJupyterKey(running, wanted, platform)) return false
  if (!Number.isInteger(running.pid) || running.pid <= 0) return false
  return stillOwned
}

/** Build the in-app URL. Always loopback — never bind Jupyter to 0.0.0.0. */
export function jupyterLabUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/lab?token=${token}`
}

const URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:\d]*\/[^\s"'<>\\]*/gi

/**
 * Pull the first loopback Jupyter URL out of server logs.
 * Jupyter prints this once it is listening (stdout or stderr).
 */
export function parseJupyterLabUrl(text: string): string | null {
  const matches = text.match(URL_RE)
  if (!matches) return null
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;]+$/, '')
    try {
      const parsed = new URL(cleaned)
      const loopback =
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '[::1]' ||
        parsed.hostname === '::1'
      if (!loopback) continue
      parsed.hostname = '127.0.0.1'
      parsed.protocol = 'http:'
      if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/lab'
      return parsed.toString()
    } catch {
      continue
    }
  }
  return null
}

/** Host+port only, so a tab that navigated inside /lab still matches. */
export function jupyterOrigin(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    if (parsed.hostname === 'localhost' || parsed.hostname === '::1') {
      parsed.hostname = '127.0.0.1'
    }
    if (parsed.hostname !== '127.0.0.1') return null
    return `http://127.0.0.1:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return null
  }
}

export function isSameJupyterOrigin(tabUrl: string, serverUrl: string): boolean {
  const a = jupyterOrigin(tabUrl)
  const b = jupyterOrigin(serverUrl)
  return !!a && !!b && a === b
}

export function redactJupyterTokens(text: string): string {
  return text.replace(/([?&]token=)[^&\s"'<>]+/gi, '$1***')
}

/**
 * Drop the Jupyter token before writing a URL to projects.json.
 * The in-app webview can still load the token URL in memory.
 */
export function persistableBrowserUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return trimmed
  try {
    const parsed = new URL(trimmed)
    const host = parsed.hostname
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (!loopback || !parsed.searchParams.has('token')) return trimmed
    parsed.searchParams.delete('token')
    let next = parsed.toString()
    if (next.endsWith('?')) next = next.slice(0, -1)
    return next
  } catch {
    return trimmed
  }
}

export function buildJupyterlabArgs(port: number, token: string, cwd: string): string[] {
  return [
    '-m',
    'jupyterlab',
    '--no-browser',
    '--ip=127.0.0.1',
    `--port=${port}`,
    '--port-retries=0',
    `--ServerApp.token=${token}`,
    '--ServerApp.password=',
    `--ServerApp.root_dir=${cwd}`
  ]
}

type PathApi = {
  join: (...parts: string[]) => string
  resolve: (...parts: string[]) => string
  relative: (from: string, to: string) => string
  isAbsolute: (p: string) => boolean
  sep: string
}

function pathApiFor(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix
}

/** True when `candidate` is `root` or a folder inside it (after resolve). */
export function isPathInsideRoot(
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
  pathApi: PathApi = pathApiFor(platform)
): boolean {
  const resolvedRoot = pathApi.resolve(root)
  const resolved = pathApi.resolve(candidate)
  const rel = pathApi.relative(resolvedRoot, resolved)
  if (rel === '') return true
  if (pathApi.isAbsolute(rel)) return false
  return rel.split(pathApi.sep)[0] !== '..'
}

/**
 * Pick a Jupyter working directory: omitted cwd → project folder.
 * A provided cwd must sit under the project folder or a worktree root.
 */
export function resolveContainedJupyterCwd(
  requested: string | undefined,
  roots: string[],
  fallback: string,
  platform: NodeJS.Platform,
  pathApi: PathApi = pathApiFor(platform)
): { ok: true; cwd: string } | { ok: false; error: string } {
  const projectDir = fallback.trim()
  if (!projectDir) return { ok: false, error: JUPYTER_ERRORS.noFolder }
  const cwd = (requested ?? '').trim() || projectDir
  const allowed = roots.map((root) => root.trim()).filter(Boolean)
  if (allowed.length === 0) allowed.push(projectDir)
  for (const root of allowed) {
    if (isPathInsideRoot(root, cwd, platform, pathApi)) {
      return { ok: true, cwd: pathApi.resolve(cwd) }
    }
  }
  return { ok: false, error: JUPYTER_ERRORS.cwdNotAllowed }
}

/** Project folder plus each task worktree (and nested project path inside it). */
export function jupyterCwdRoots(project: {
  directory?: string
  tasks?: Array<{ workspace?: { worktreePath: string; relativeProjectPath?: string } }>
}): string[] {
  const roots: string[] = []
  const dir = project.directory?.trim()
  if (dir) roots.push(dir)
  for (const task of project.tasks ?? []) {
    const worktree = task.workspace?.worktreePath?.trim()
    if (!worktree) continue
    roots.push(worktree)
    const nested = joinWorkspaceDir(worktree, task.workspace?.relativeProjectPath)
    if (nested !== worktree) roots.push(nested)
  }
  return roots
}

/** python.exe at the env prefix (Windows) or prefix/bin/python (Unix). */
export function condaPythonExecutable(
  prefix: string,
  deps: {
    platform: NodeJS.Platform
    path: { join: (...parts: string[]) => string }
    existsSync: (filePath: string) => boolean
  }
): string | null {
  const trimmed = prefix.trim()
  if (!trimmed) return null
  if (deps.platform === 'win32') {
    const exe = deps.path.join(trimmed, 'python.exe')
    return deps.existsSync(exe) ? exe : null
  }
  for (const name of ['python', 'python3']) {
    const bin = deps.path.join(trimmed, 'bin', name)
    if (deps.existsSync(bin)) return bin
  }
  return null
}
