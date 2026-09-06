import fs from 'fs'
import type { AppConfig } from '../shared/types'
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

function requireExistingFile(file: string, deps: ShellEnvDeps, missing: string): string {
  const existsSync = deps.existsSync ?? fs.existsSync
  if (existsSync(file)) return file
  throw new Error(missing)
}

/**
 * File + args for a local interactive terminal tab.
 * On Windows this is always Git Bash — inherited SHELL and PowerShell/cmd are ignored.
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

/** Local Git Bash (Windows) or login shell (Unix) — not SSH, not Pi/Claude/Codex, not `sh -c`. */
export function isLocalInteractiveTerminal(shell: string, args?: string[]): boolean {
  if ((args ?? []).includes('-c')) return false
  if (shell === '$SHELL') return false
  return true
}
