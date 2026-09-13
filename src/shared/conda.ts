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
