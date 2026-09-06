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
/** Git Bash PATH converted to Windows `C:\...;...` form. Never written to process.env.PATH. */
let windowsLoginPath: string | null = null
let portableNodeDir = ''

/** Keys CreateProcess / ConPTY need in Windows form. Do not copy MSYS versions over them. */
const WINDOWS_PROCESS_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'COMSPEC',
  'ComSpec',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'windir',
  'SYSTEMDRIVE',
  'SystemDrive',
  'TEMP',
  'TMP',
  'TMPDIR'
])

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

/** `Git\\bin\\bash.exe` → Git root; `Git\\usr\\bin\\bash.exe` → Git root. */
export function gitInstallRoot(bashExe: string, deps: ShellEnvDeps = {}): string {
  const pathMod = pathOf(deps)
  const binDir = pathMod.dirname(bashExe)
  const binName = pathMod.basename(binDir)
  if (binName.toLowerCase() === 'bin') {
    const parent = pathMod.dirname(binDir)
    if (pathMod.basename(parent).toLowerCase() === 'usr') return pathMod.dirname(parent)
    return parent
  }
  return binDir
}

/**
 * One Git Bash PATH entry → a Windows directory.
 * `/c/Users/me` → `C:\Users\me`. `/usr/bin` → `<Git>\usr\bin`.
 */
export function msysPathEntryToWindows(entry: string, gitRoot: string, deps: ShellEnvDeps = {}): string {
  const pathMod = pathOf(deps)
  const trimmed = entry.trim()
  if (!trimmed) return ''
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    return trimmed.replace(/\//g, '\\')
  }
  const drive = trimmed.match(/^\/([a-zA-Z])(\/.*)?$/)
  if (drive) {
    const rest = (drive[2] || '').replace(/\//g, '\\')
    return `${drive[1].toUpperCase()}:${rest || '\\'}`
  }
  const relative = trimmed.match(/^\/(usr|bin|mingw64|mingw32)(\/.*)?$/)
  if (relative) {
    const rest = trimmed.replace(/^\//, '').replace(/\//g, '\\')
    return pathMod.join(gitRoot, rest)
  }
  return ''
}

/** Colon-separated MSYS PATH → semicolon-separated Windows PATH. */
export function msysPathListToWindows(pathList: string, gitRoot: string, deps: ShellEnvDeps = {}): string {
  return pathList
    .split(':')
    .map((part) => msysPathEntryToWindows(part, gitRoot, deps))
    .filter(Boolean)
    .join(';')
}

/** True for `...\Git\bin\bash.exe`, false for `...\Git\usr\bin\bash.exe`. */
export function isGitBinBashExe(file: string): boolean {
  return file.replace(/\//g, '\\').toLowerCase().endsWith('\\git\\bin\\bash.exe')
}

/** Locate Git Bash so we can dump a login PATH and spawn a PTY on Windows. */
export function findGitBashExe(deps: ShellEnvDeps = {}): string | null {
  const pathMod = pathOf(deps)
  const env = envOf(deps)
  const existsSync = deps.existsSync ?? fs.existsSync
  const pathDirs = (env.PATH || env.Path || '').split(pathMod.delimiter)
  const dirs = [...pathDirs, ...extraWindowsSearchDirs(env, pathMod as typeof path.win32)].filter(Boolean)
  const seen = new Set<string>()
  const found: string[] = []
  for (const dir of dirs) {
    const candidate = pathMod.join(dir, 'bash.exe')
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (existsSync(candidate)) found.push(candidate)
  }
  // Git\bin\bash.exe is the Git Bash launcher; usr\bin is MSYS bash on PATH.
  return found.find(isGitBinBashExe) ?? found[0] ?? null
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
 *
 * Do not copy Git Bash's Unix PATH onto process.env.PATH. node-pty ConPTY
 * resolves relative files like `cmd.exe` with that PATH; a `/c/...:/usr/bin`
 * value makes the lookup return empty ("File not found: ").
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
      if (platform === 'win32') {
        windowsLoginPath = msysPathListToWindows(pathValue, gitInstallRoot(shell, deps), deps)
      } else {
        if (deps.env) deps.env.PATH = pathValue
        else process.env.PATH = pathValue
      }
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
  const platform = platformOf(deps)
  const live = envOf(deps) as Record<string, string>

  if (platform === 'win32') {
    const base: Record<string, string> = { ...live }
    if (resolvedEnv) {
      for (const [key, value] of Object.entries(resolvedEnv)) {
        if (WINDOWS_PROCESS_KEYS.has(key)) continue
        if (key === 'PWD' || key === 'pwd') continue
        base[key] = value
      }
    }
    // Login bash otherwise cds to $HOME. Do not keep dumped PWD (Electron's cwd).
    delete base.PWD
    delete base.pwd
    base.CHERE_INVOKING = '1'
    if (windowsLoginPath) {
      base.PATH = windowsLoginPath
      if ('Path' in base) base.Path = windowsLoginPath
    }
    return prependDirToPath(base, portableNodeDir, deps)
  }

  const base = resolvedEnv ?? live
  return prependDirToPath(base, portableNodeDir, deps)
}

/** Test helper: clear cached login env and the Node-dir override. */
export function resetShellEnvForTests(): void {
  resolvedEnv = null
  windowsLoginPath = null
  portableNodeDir = ''
}
