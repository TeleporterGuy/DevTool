import fs from 'fs'
import path from 'path'
import type { AppConfig, WindowsTerminal } from '../shared/types'
import { findGitBashExe, type ShellEnvDeps } from './shell-env'

export interface LocalTerminalSpawn {
  file: string
  args: string[]
}

const MISSING_GIT_BASH =
  'Cannot find Git Bash. Install Git for Windows, or set the path in Settings → Terminal.'

function envOf(deps: ShellEnvDeps = {}): NodeJS.ProcessEnv {
  return deps.env ?? process.env
}

function platformOf(deps: ShellEnvDeps = {}): NodeJS.Platform {
  return deps.platform ?? process.platform
}

function windowsPreset(value: WindowsTerminal | undefined): WindowsTerminal {
  if (value === 'powershell' || value === 'cmd') return value
  return 'git-bash'
}

function windowsPowerShellExe(deps: ShellEnvDeps = {}): string {
  const env = envOf(deps)
  const pathMod = deps.path ?? path.win32
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  return pathMod.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function windowsCmdExe(deps: ShellEnvDeps = {}): string {
  const env = envOf(deps)
  const fromEnv = env.ComSpec || env.COMSPEC
  if (fromEnv?.trim()) return fromEnv.trim()
  const pathMod = deps.path ?? path.win32
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  return pathMod.join(root, 'System32', 'cmd.exe')
}

function requireExistingFile(file: string, deps: ShellEnvDeps, missing: string): string {
  const existsSync = deps.existsSync ?? fs.existsSync
  if (existsSync(file)) return file
  throw new Error(missing)
}

/**
 * File + args for a local interactive terminal tab.
 * On Windows this ignores inherited SHELL so Explorer / cmd launches match Git-Bash-started `npm run dev`.
 */
export function resolveLocalTerminalSpawn(
  config: Pick<AppConfig, 'defaultShell' | 'windowsTerminal'>,
  deps: ShellEnvDeps = {}
): LocalTerminalSpawn {
  const platform = platformOf(deps)
  const env = envOf(deps)
  const override = config.defaultShell.trim()

  if (platform !== 'win32') {
    const file = override || env.SHELL || '/bin/sh'
    return { file, args: ['-l'] }
  }

  const preset = windowsPreset(config.windowsTerminal)

  if (preset === 'powershell') {
    const file = windowsPowerShellExe(deps)
    return { file, args: ['-NoLogo'] }
  }

  if (preset === 'cmd') {
    return { file: windowsCmdExe(deps), args: [] }
  }

  if (override) {
    const file = requireExistingFile(
      override,
      deps,
      `Cannot find Git Bash at "${override}". Pick bash.exe in Settings → Terminal.`
    )
    return { file, args: ['--login', '-i'] }
  }

  const found = findGitBashExe(deps)
  if (!found) throw new Error(MISSING_GIT_BASH)
  return { file: found, args: ['--login', '-i'] }
}

/** Local Git Bash / PowerShell / cmd — not SSH, not Pi/Claude/Codex, not `sh -c`. */
export function isLocalInteractiveTerminal(shell: string, args?: string[]): boolean {
  if ((args ?? []).includes('-c')) return false
  if (shell === '$SHELL') return false
  return true
}
