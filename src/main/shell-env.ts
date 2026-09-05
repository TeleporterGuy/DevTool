import { execFile as execFileCb, type ExecFileOptions } from 'child_process'
import fs from 'fs'
import path from 'path'
import { extraWindowsSearchDirs } from './resolve-agent-command'

type PathApi = typeof path.win32 | typeof path.posix

type ExecFileFn = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void

export interface ShellEnvDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  existsSync?: (filePath: string) => boolean
  path?: PathApi
  execFile?: ExecFileFn
}

let resolvedEnv: Record<string, string> | null = null
let portableNodeDir = ''

const execFile: ExecFileFn = execFileCb as ExecFileFn

function platformOf(deps: ShellEnvDeps = {}): NodeJS.Platform {
  return deps.platform ?? process.platform
}

function pathOf(deps: ShellEnvDeps = {}): PathApi {
  if (deps.path) return deps.path
  return platformOf(deps) === 'win32' ? path.win32 : path.posix
}

function envOf(deps: ShellEnvDeps = {}): NodeJS.ProcessEnv {
  return deps.env ?? process.env
}

/** Turn a Settings value into a directory to prepend. `node.exe` / `node` → parent folder. */
export function normalizePortableNodeDir(raw: string, deps: ShellEnvDeps = {}): string {
  const pathMod = pathOf(deps)
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const base = pathMod.basename(trimmed)
  const platform = platformOf(deps)
  const isNodeBinary =
    /^node\.exe$/i.test(base) || (platform !== 'win32' && base === 'node')
  if (isNodeBinary) return pathMod.dirname(trimmed)
  return trimmed
}

/** Put `dir` first on PATH. Drops an existing copy of the same folder so it is not duplicated. */
export function prependDirToPath(
  env: Record<string, string>,
  dir: string,
  deps: ShellEnvDeps = {}
): Record<string, string> {
  const normalized = normalizePortableNodeDir(dir, deps)
  if (!normalized) return env

  const platform = platformOf(deps)
  const pathMod = pathOf(deps)
  const delim = pathMod.delimiter
  const next = { ...env }
  const current = next.PATH ?? next.Path ?? ''
  const same = (left: string, right: string) =>
    platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  const rest = current.split(delim).filter((part) => part && !same(part, normalized))
  next.PATH = [normalized, ...rest].join(delim)
  if (platform === 'win32' && 'Path' in next) next.Path = next.PATH
  return next
}

export function parseNullDelimitedEnv(dump: string): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const entry of dump.split('\0')) {
    const idx = entry.indexOf('=')
    if (idx > 0) parsed[entry.slice(0, idx)] = entry.slice(idx + 1)
  }
  return parsed
}

/** Locate Git Bash so we can dump a login PATH on Windows. */
export function findGitBashExe(deps: ShellEnvDeps = {}): string | null {
  const pathMod = pathOf(deps)
  const env = envOf(deps)
  const existsSync = deps.existsSync ?? fs.existsSync
  const pathDirs = (env.PATH || env.Path || '').split(pathMod.delimiter)
  const dirs = [...pathDirs, ...extraWindowsSearchDirs(env, pathMod as typeof path.win32)].filter(Boolean)
  const seen = new Set<string>()
  for (const dir of dirs) {
    const candidate = pathMod.join(dir, 'bash.exe')
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function dumpLoginEnv(file: string, deps: ShellEnvDeps = {}): Promise<string> {
  const run = deps.execFile ?? execFile
  return new Promise((resolve, reject) => {
    run(file, ['-ilc', 'env -0'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * Resolve the user's shell environment by spawning a login shell.
 * On macOS, GUI apps launched from Finder get a minimal PATH.
 * On Windows, Electron is the same: capture Git Bash login env instead of skipping.
 */
export async function resolveShellEnv(deps: ShellEnvDeps = {}): Promise<void> {
  const platform = platformOf(deps)
  const env = envOf(deps)
  const shell = platform === 'win32' ? findGitBashExe(deps) : env.SHELL || '/bin/zsh'
  if (!shell) return

  try {
    const dump = await dumpLoginEnv(shell, deps)
    const parsed = parseNullDelimitedEnv(dump)
    const pathValue = parsed.PATH || parsed.Path
    if (pathValue) {
      resolvedEnv = parsed
      // Child_process and later prepends read process.env.PATH too.
      if (deps.env) deps.env.PATH = pathValue
      else process.env.PATH = pathValue
    }
  } catch {
    // Fall back to process.env if shell resolution fails
  }
}

/** Live Settings value. Applied in getShellEnv so changing it does not require recapturing login env. */
export function setPortableNodeDir(dir: string): void {
  portableNodeDir = dir
}

export function getShellEnv(deps: ShellEnvDeps = {}): Record<string, string> {
  const base = resolvedEnv ?? (envOf(deps) as Record<string, string>)
  return prependDirToPath(base, portableNodeDir, deps)
}

/** Test helper: clear cached login env and the Node-dir override. */
export function resetShellEnvForTests(): void {
  resolvedEnv = null
  portableNodeDir = ''
}
