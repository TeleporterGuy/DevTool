/** Conda / micromamba spawn-time env picker (Phase 3). */

export type CondaKind = 'conda' | 'micromamba'

export interface CondaExecutable {
  kind: CondaKind
  file: string
}

/** One named env DevTool can prepend onto a PTY's PATH. */
export interface CondaEnvInfo {
  name: string
  prefix: string
}

export interface CondaListResult {
  executable: CondaExecutable | null
  envs: CondaEnvInfo[]
  error?: string
}

/** Select value for a name-only saved env that is not in the live list. */
export const CONDA_SAVED_NAME_PREFIX = '__name__:'

export interface ProjectCondaSelection {
  condaEnvName?: string
  condaEnvPrefix?: string
}

/** Last folder of a prefix path (`C:\\envs\\ml` → `ml`). */
export function lastPathSegment(prefix: string): string {
  const trimmed = prefix.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * Envs whose name matches `wanted`.
 * Exact matches win. On Windows, a case-insensitive match is used only when
 * exactly one env would match — two folders that differ only by case stay ambiguous.
 */
export function condaEnvsMatchingName(
  envs: CondaEnvInfo[],
  wanted: string,
  platform: string
): CondaEnvInfo[] {
  const name = wanted.trim()
  if (!name) return []
  const exact = envs.filter((env) => env.name === name)
  if (exact.length > 0) return exact
  if (platform === 'win32') {
    const folded = name.toLowerCase()
    const insensitive = envs.filter((env) => env.name.toLowerCase() === folded)
    if (insensitive.length === 1) return insensitive
  }
  return []
}

/** Unique name hit, or null when missing / duplicated. */
export function uniqueCondaEnvForName(
  envs: CondaEnvInfo[],
  wanted: string,
  platform: string
): CondaEnvInfo | null {
  const matches = condaEnvsMatchingName(envs, wanted, platform)
  return matches.length === 1 ? matches[0] : null
}

/**
 * Dropdown value: saved prefix when present (unique even if two envs share a name).
 * Name-only legacy projects map to a prefix when the name is unique in `envs`.
 */
export function condaSelectValue(
  project: ProjectCondaSelection,
  envs: CondaEnvInfo[],
  platform: string
): string {
  const prefix = project.condaEnvPrefix?.trim() ?? ''
  if (prefix) return prefix
  const name = project.condaEnvName?.trim() ?? ''
  if (!name) return ''
  const unique = uniqueCondaEnvForName(envs, name, platform)
  if (unique) return unique.prefix
  return `${CONDA_SAVED_NAME_PREFIX}${name}`
}

/** Persist both name and prefix from a dropdown value. Empty value clears both. */
export function condaEnvFromSelection(
  value: string,
  envs: CondaEnvInfo[]
): ProjectCondaSelection {
  const trimmed = value.trim()
  if (!trimmed) return { condaEnvName: undefined, condaEnvPrefix: undefined }
  if (trimmed.startsWith(CONDA_SAVED_NAME_PREFIX)) {
    const name = trimmed.slice(CONDA_SAVED_NAME_PREFIX.length).trim()
    return { condaEnvName: name || undefined, condaEnvPrefix: undefined }
  }
  const env = envs.find((item) => item.prefix === trimmed)
  if (env) return { condaEnvName: env.name, condaEnvPrefix: env.prefix }
  // Prefix was saved but is not in the current list — keep it as the identity.
  return {
    condaEnvName: lastPathSegment(trimmed) || undefined,
    condaEnvPrefix: trimmed
  }
}

export function condaSavedOptionVisible(value: string, envs: CondaEnvInfo[]): boolean {
  if (!value) return false
  if (value.startsWith(CONDA_SAVED_NAME_PREFIX)) return true
  return !envs.some((env) => env.prefix === value)
}

export function condaSavedOptionLabel(value: string, savedName?: string): string {
  if (value.startsWith(CONDA_SAVED_NAME_PREFIX)) {
    return `${value.slice(CONDA_SAVED_NAME_PREFIX.length)} (saved)`
  }
  const name = savedName?.trim() || lastPathSegment(value)
  return `${name} (saved)`
}
