import { execFile as execFileCb, type ExecFileOptions } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { CondaEnvInfo, CondaExecutable, CondaKind, CondaListResult } from '../shared/conda'

type PathApi = typeof path.win32 | typeof path.posix

type ExecFileFn = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void

export interface CondaEnvDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homedir?: string
  existsSync?: (filePath: string) => boolean
  readdirSync?: (dir: string) => string[]
  readFileSync?: (filePath: string, encoding: 'utf-8') => string
  path?: PathApi
  execFile?: ExecFileFn
}

const execFile: ExecFileFn = execFileCb as ExecFileFn

let cachedList: CondaListResult | null = null

function platformOf(deps: CondaEnvDeps = {}): NodeJS.Platform {
  return deps.platform ?? process.platform
}

function pathOf(deps: CondaEnvDeps = {}): PathApi {
  if (deps.path) return deps.path
  return platformOf(deps) === 'win32' ? path.win32 : path.posix
}

function envOf(deps: CondaEnvDeps = {}): NodeJS.ProcessEnv {
  return deps.env ?? process.env
}

function homedirOf(deps: CondaEnvDeps = {}): string {
  return deps.homedir ?? envOf(deps).USERPROFILE ?? envOf(deps).HOME ?? os.homedir()
}

function existsOf(deps: CondaEnvDeps = {}): (filePath: string) => boolean {
  return deps.existsSync ?? fs.existsSync
}

function samePath(left: string, right: string, deps: CondaEnvDeps = {}): boolean {
  const a = left.replace(/[\\/]+$/, '')
  const b = right.replace(/[\\/]+$/, '')
  return platformOf(deps) === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function kindFromFile(file: string): CondaKind {
  return /micromamba(\.exe)?$/i.test(file) ? 'micromamba' : 'conda'
}

/** Install prefix that contains `envs/` and the `base` env. */
export function installRootFromCondaFile(file: string, deps: CondaEnvDeps = {}): string {
  const pathMod = pathOf(deps)
  const dir = pathMod.dirname(file)
  const folder = pathMod.basename(dir).toLowerCase()
  if (folder === 'scripts' || folder === 'condabin' || folder === 'bin') {
    return pathMod.dirname(dir)
  }
  return dir
}

/**
 * Name conda would show for a prefix.
 * The root install is `base`; anything sitting in an `envs` folder uses that folder name.
 */
export function envNameFromPrefix(prefix: string, rootPrefix: string | undefined, deps: CondaEnvDeps = {}): string {
  const pathMod = pathOf(deps)
  const trimmed = prefix.replace(/[\\/]+$/, '')
  if (rootPrefix && samePath(trimmed, rootPrefix, deps)) return 'base'
  const parent = pathMod.basename(pathMod.dirname(trimmed))
  if (parent.toLowerCase() === 'envs') return pathMod.basename(trimmed)
  if (rootPrefix) return pathMod.basename(trimmed)
  return pathMod.basename(trimmed) || 'base'
}

/** Folders conda activate prepends for the env prefix. Missing ones are dropped later. */
export function condaPathDirs(prefix: string, deps: CondaEnvDeps = {}): string[] {
  const pathMod = pathOf(deps)
  if (platformOf(deps) === 'win32') {
    return [
      prefix,
      pathMod.join(prefix, 'Library', 'mingw-w64', 'bin'),
      pathMod.join(prefix, 'Library', 'usr', 'bin'),
      pathMod.join(prefix, 'Library', 'bin'),
      pathMod.join(prefix, 'Scripts'),
      pathMod.join(prefix, 'bin')
    ]
  }
  return [pathMod.join(prefix, 'bin')]
}

/** Install-root folders that contain `conda.exe` / the conda entry-point (not the env's python). */
export function condaInstallToolDirs(root: string, deps: CondaEnvDeps = {}): string[] {
  const pathMod = pathOf(deps)
  if (platformOf(deps) === 'win32') {
    return [pathMod.join(root, 'condabin'), pathMod.join(root, 'Scripts')]
  }
  return [pathMod.join(root, 'condabin'), pathMod.join(root, 'bin')]
}

/**
 * PATH dirs for a spawn: env prefix first (python), then install condabin/Scripts
 * so `conda` still resolves when the shell function is missing.
 */
export function condaSpawnPathDirs(condaEnv: CondaEnvInfo, deps: CondaEnvDeps = {}): string[] {
  const prefix = condaEnv.prefix.trim()
  const root = condaRootFromEnvPrefix(condaEnv, deps)
  const envDirs = condaPathDirs(prefix, deps)
  const seen = new Set(
    envDirs.map((dir) => (platformOf(deps) === 'win32' ? dir.toLowerCase() : dir))
  )
  const extra: string[] = []
  for (const dir of condaInstallToolDirs(root, deps)) {
    const key = platformOf(deps) === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    extra.push(dir)
  }
  return [...envDirs, ...extra]
}

export function isCondaEnvPrefix(prefix: string, deps: CondaEnvDeps = {}): boolean {
  const pathMod = pathOf(deps)
  const existsSync = existsOf(deps)
  if (existsSync(pathMod.join(prefix, 'conda-meta'))) return true
  if (platformOf(deps) === 'win32') {
    return existsSync(pathMod.join(prefix, 'python.exe'))
  }
  return (
    existsSync(pathMod.join(prefix, 'bin', 'python')) ||
    existsSync(pathMod.join(prefix, 'bin', 'python3'))
  )
}

function readDirNames(dir: string, deps: CondaEnvDeps = {}): string[] {
  try {
    if (deps.readdirSync) return deps.readdirSync(dir)
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function readTextFile(filePath: string, deps: CondaEnvDeps = {}): string {
  try {
    if (deps.readFileSync) return deps.readFileSync(filePath, 'utf-8')
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function condaNames(deps: CondaEnvDeps = {}): string[] {
  return platformOf(deps) === 'win32' ? ['conda.exe'] : ['conda']
}

function micromambaNames(deps: CondaEnvDeps = {}): string[] {
  return platformOf(deps) === 'win32' ? ['micromamba.exe'] : ['micromamba']
}

/** Well-known Anaconda / Miniconda / Miniforge / micromamba locations Electron's PATH often omits. */
export function extraCondaCandidateFiles(deps: CondaEnvDeps = {}): string[] {
  const pathMod = pathOf(deps)
  const env = envOf(deps)
  const home = homedirOf(deps)
  const platform = platformOf(deps)
  const files: string[] = []
  const add = (filePath: string): void => {
    if (filePath) files.push(filePath)
  }

  if (platform === 'win32') {
    const roots = [
      pathMod.join(home, 'miniconda3'),
      pathMod.join(home, 'anaconda3'),
      pathMod.join(home, 'miniforge3'),
      pathMod.join(home, 'mambaforge')
    ]
    if (env.LOCALAPPDATA) {
      roots.push(
        pathMod.join(env.LOCALAPPDATA, 'miniconda3'),
        pathMod.join(env.LOCALAPPDATA, 'anaconda3'),
        pathMod.join(env.LOCALAPPDATA, 'miniforge3'),
        pathMod.join(env.LOCALAPPDATA, 'mambaforge'),
        pathMod.join(env.LOCALAPPDATA, 'Programs', 'miniconda3')
      )
    }
    roots.push(
      'C:\\ProgramData\\miniconda3',
      'C:\\ProgramData\\anaconda3',
      'C:\\ProgramData\\miniforge3',
      'C:\\ProgramData\\mambaforge'
    )
    for (const root of roots) {
      add(pathMod.join(root, 'Scripts', 'conda.exe'))
      add(pathMod.join(root, 'condabin', 'conda.exe'))
    }
    add(pathMod.join(home, 'micromamba', 'micromamba.exe'))
    add(pathMod.join(home, 'micromamba.exe'))
    if (env.LOCALAPPDATA) {
      add(pathMod.join(env.LOCALAPPDATA, 'micromamba', 'micromamba.exe'))
    }
    return files
  }

  const roots = [
    pathMod.join(home, 'miniconda3'),
    pathMod.join(home, 'anaconda3'),
    pathMod.join(home, 'miniforge3'),
    pathMod.join(home, 'mambaforge'),
    '/opt/conda',
    '/opt/miniconda3',
    '/opt/miniforge3'
  ]
  for (const root of roots) {
    add(pathMod.join(root, 'bin', 'conda'))
    add(pathMod.join(root, 'condabin', 'conda'))
  }
  add(pathMod.join(home, '.local', 'bin', 'micromamba'))
  add(pathMod.join(home, 'bin', 'micromamba'))
  add(pathMod.join(home, 'micromamba', 'bin', 'micromamba'))
  add('/usr/local/bin/micromamba')
  return files
}

function pathCandidateFiles(deps: CondaEnvDeps = {}): { conda: string[]; micromamba: string[] } {
  const pathMod = pathOf(deps)
  const env = envOf(deps)
  const dirs = (env.PATH || env.Path || '').split(pathMod.delimiter).filter(Boolean)
  const conda: string[] = []
  const micromamba: string[] = []
  for (const dir of dirs) {
    for (const name of condaNames(deps)) conda.push(pathMod.join(dir, name))
    for (const name of micromambaNames(deps)) micromamba.push(pathMod.join(dir, name))
  }
  return { conda, micromamba }
}

function firstExisting(files: string[], deps: CondaEnvDeps = {}): string | null {
  const existsSync = existsOf(deps)
  const seen = new Set<string>()
  for (const file of files) {
    const key = platformOf(deps) === 'win32' ? file.toLowerCase() : file
    if (seen.has(key)) continue
    seen.add(key)
    if (existsSync(file)) return file
  }
  return null
}

/**
 * Locate conda.exe (Anaconda / Miniconda / Miniforge) or micromamba.
 * Prefers conda when both exist. CONDA_EXE / MAMBA_EXE win when they point at a real file.
 */
export function findCondaExecutable(deps: CondaEnvDeps = {}): CondaExecutable | null {
  const env = envOf(deps)
  const existsSync = existsOf(deps)
  const fromEnv =
    (env.CONDA_EXE && existsSync(env.CONDA_EXE) ? env.CONDA_EXE : '') ||
    (env.MAMBA_EXE && existsSync(env.MAMBA_EXE) ? env.MAMBA_EXE : '') ||
    (env.MICROMAMBA && existsSync(env.MICROMAMBA) ? env.MICROMAMBA : '')
  if (fromEnv) {
    return { kind: kindFromFile(fromEnv), file: fromEnv }
  }

  const pathFiles = pathCandidateFiles(deps)
  const extra = extraCondaCandidateFiles(deps)
  const extraConda = extra.filter((file) => kindFromFile(file) === 'conda')
  const extraMamba = extra.filter((file) => kindFromFile(file) === 'micromamba')
  const condaFile = firstExisting([...pathFiles.conda, ...extraConda], deps)
  if (condaFile) return { kind: 'conda', file: condaFile }
  const mambaFile = firstExisting([...pathFiles.micromamba, ...extraMamba], deps)
  if (mambaFile) return { kind: 'micromamba', file: mambaFile }
  return null
}

function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const match = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (!match) throw new Error('conda env list did not print JSON')
    return JSON.parse(match[1])
  }
}

function asPrefixList(value: unknown, rootPrefix: string | undefined, deps: CondaEnvDeps): CondaEnvInfo[] {
  const items: Array<{ name?: string; prefix: string }> = []
  const push = (name: unknown, prefix: unknown): void => {
    if (typeof prefix !== 'string' || !prefix.trim()) return
    items.push({
      prefix: prefix.trim(),
      name: typeof name === 'string' && name.trim() ? name.trim() : undefined
    })
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') push(undefined, item)
      else if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        push(rec.name, rec.prefix ?? rec.root ?? rec.path)
      }
    }
  } else if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const nestedRoot = typeof rec.root_prefix === 'string' ? rec.root_prefix : rootPrefix
    if (Array.isArray(rec.envs)) {
      return asPrefixList(rec.envs, nestedRoot, deps)
    }
  }

  return items.map((item) => ({
    name: item.name ?? envNameFromPrefix(item.prefix, rootPrefix, deps),
    prefix: item.prefix
  }))
}

/** Parse `conda env list --json` or `micromamba env list --json`. */
export function parseCondaEnvListJson(
  raw: string,
  rootPrefix: string | undefined,
  deps: CondaEnvDeps = {}
): CondaEnvInfo[] {
  return asPrefixList(extractJson(raw), rootPrefix, deps)
}

export function parseEnvironmentsTxt(
  content: string,
  rootPrefix: string | undefined,
  deps: CondaEnvDeps = {}
): CondaEnvInfo[] {
  const envs: CondaEnvInfo[] = []
  for (const line of content.split(/\r?\n/)) {
    const prefix = line.trim()
    if (!prefix || prefix.startsWith('#')) continue
    envs.push({ name: envNameFromPrefix(prefix, rootPrefix, deps), prefix })
  }
  return envs
}

function mergeEnvs(groups: CondaEnvInfo[][], deps: CondaEnvDeps = {}): CondaEnvInfo[] {
  const out: CondaEnvInfo[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const env of group) {
      const key = platformOf(deps) === 'win32' ? env.prefix.toLowerCase() : env.prefix
      if (seen.has(key)) continue
      seen.add(key)
      out.push(env)
    }
  }
  return out
}

function wellKnownRoots(deps: CondaEnvDeps = {}): string[] {
  const pathMod = pathOf(deps)
  const env = envOf(deps)
  const home = homedirOf(deps)
  const roots = [
    env.CONDA_PREFIX,
    env.MAMBA_ROOT_PREFIX,
    pathMod.join(home, 'miniconda3'),
    pathMod.join(home, 'anaconda3'),
    pathMod.join(home, 'miniforge3'),
    pathMod.join(home, 'mambaforge'),
    pathMod.join(home, 'micromamba')
  ]
  if (platformOf(deps) === 'win32') {
    if (env.LOCALAPPDATA) {
      roots.push(
        pathMod.join(env.LOCALAPPDATA, 'miniconda3'),
        pathMod.join(env.LOCALAPPDATA, 'anaconda3'),
        pathMod.join(env.LOCALAPPDATA, 'miniforge3'),
        pathMod.join(env.LOCALAPPDATA, 'micromamba')
      )
    }
    roots.push(
      'C:\\ProgramData\\miniconda3',
      'C:\\ProgramData\\anaconda3',
      'C:\\ProgramData\\miniforge3'
    )
  } else {
    roots.push('/opt/conda', '/opt/miniconda3', '/opt/miniforge3')
  }
  return roots.filter((root): root is string => !!root)
}

function envsUnderRoot(root: string, deps: CondaEnvDeps = {}): CondaEnvInfo[] {
  const pathMod = pathOf(deps)
  const found: CondaEnvInfo[] = []
  if (isCondaEnvPrefix(root, deps)) {
    found.push({ name: 'base', prefix: root })
  }
  const envsDir = pathMod.join(root, 'envs')
  for (const name of readDirNames(envsDir, deps)) {
    if (name.startsWith('.')) continue
    const prefix = pathMod.join(envsDir, name)
    if (isCondaEnvPrefix(prefix, deps)) found.push({ name, prefix })
  }
  return found
}

/** Prefixes from environments.txt and well-known install folders — no conda process needed. */
export function listCondaEnvsFromFilesystem(deps: CondaEnvDeps = {}): CondaEnvInfo[] {
  const pathMod = pathOf(deps)
  const home = homedirOf(deps)
  const executable = findCondaExecutable(deps)
  const roots = wellKnownRoots(deps)
  if (executable) roots.unshift(installRootFromCondaFile(executable.file, deps))
  const txt = readTextFile(pathMod.join(home, '.conda', 'environments.txt'), deps)
  const fromTxt = parseEnvironmentsTxt(txt, executable ? installRootFromCondaFile(executable.file, deps) : undefined, deps)
  const fromDirs = roots.flatMap((root) => envsUnderRoot(root, deps))
  return mergeEnvs([fromTxt, fromDirs], deps)
}

function dumpEnvList(file: string, kind: CondaKind, deps: CondaEnvDeps = {}): Promise<string> {
  const run = deps.execFile ?? execFile
  const args = kind === 'micromamba' ? ['env', 'list', '-q', '--json'] : ['env', 'list', '--json']
  const env = envOf(deps)
  return new Promise((resolve, reject) => {
    run(file, args, { timeout: 8000, windowsHide: true, env }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * Detect conda/micromamba and list named envs.
 * Prefers `conda env list --json`; falls back to folders DevTool can see on disk.
 */
export async function listCondaEnvs(
  deps: CondaEnvDeps = {},
  options: { force?: boolean } = {}
): Promise<CondaListResult> {
  if (cachedList && !options.force) return cachedList

  const executable = findCondaExecutable(deps)
  const filesystem = listCondaEnvsFromFilesystem(deps)
  let fromCli: CondaEnvInfo[] = []
  let error: string | undefined

  if (executable) {
    try {
      const dump = await dumpEnvList(executable.file, executable.kind, deps)
      const root = installRootFromCondaFile(executable.file, deps)
      fromCli = parseCondaEnvListJson(dump, root, deps)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  const envs = mergeEnvs([fromCli, filesystem], deps)
  const result: CondaListResult = {
    executable,
    envs,
    ...(error && envs.length === 0 ? { error } : {})
  }
  cachedList = result
  return result
}

/**
 * Prefix for a saved env name. Uses the last list cache, then folders on disk.
 * Spawn is synchronous, so this must not shell out to conda.
 */
export function resolveCondaEnvPrefix(name: string, deps: CondaEnvDeps = {}): string | null {
  const wanted = name.trim()
  if (!wanted) return null
  const pool = [
    ...(cachedList?.envs ?? []),
    ...listCondaEnvsFromFilesystem(deps)
  ]
  const hit = pool.find((env) => env.name === wanted)
  return hit?.prefix ?? null
}

export function resetCondaEnvForTests(): void {
  cachedList = null
}

export function setCachedCondaEnvsForTests(envs: CondaEnvInfo[]): void {
  cachedList = { executable: null, envs }
}

/** Quote for `sh`/`bash`/`zsh -c` so env names with spaces stay one word. */
export function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Install root that contains `etc/profile.d/conda.sh` (`base`, or parent of `envs/<name>`). */
export function condaRootFromEnvPrefix(condaEnv: CondaEnvInfo, deps: CondaEnvDeps = {}): string {
  const pathMod = pathOf(deps)
  const prefix = condaEnv.prefix.replace(/[\\/]+$/, '')
  if (condaEnv.name.trim() === 'base') return prefix
  const envsDir = pathMod.dirname(prefix)
  if (pathMod.basename(envsDir).toLowerCase() === 'envs') return pathMod.dirname(envsDir)
  return prefix
}

export interface InteractiveShellSpawn {
  file: string
  args: string[]
}

function condaShPath(condaEnv: CondaEnvInfo, deps: CondaEnvDeps = {}): string {
  return pathOf(deps)
    .join(condaRootFromEnvPrefix(condaEnv, deps), 'etc', 'profile.d', 'conda.sh')
    .replace(/\\/g, '/')
}

function condaActivateCommands(condaEnv: CondaEnvInfo, deps: CondaEnvDeps = {}): string[] {
  const name = posixSingleQuote(condaEnv.name.trim())
  const condaSh = posixSingleQuote(condaShPath(condaEnv, deps))
  return [
    'export CONDA_AUTO_ACTIVATE_BASE=false',
    `if [ -f ${condaSh} ]; then . ${condaSh}; fi`,
    // Fail soft: condabin prepend still leaves conda.exe on PATH if activate cannot run.
    `conda activate ${name} 2>/dev/null || micromamba activate ${name} 2>/dev/null || true`
  ]
}

/**
 * Script run with `shell -l -i -c …` so login rc (conda initialize) runs first.
 * That hook often `conda activate base`; this then activates the project env.
 *
 * On macOS, `exec zsh -i` re-reads `.zshrc` (where conda init usually lives).
 * On Windows Git Bash, conda init is in the **login** profile (`.bash_profile`),
 * so `exec bash -i` would drop the conda function. Inner Git Bash uses `--rcfile`
 * that re-sources conda.sh, activates again, then `.bashrc`.
 */
export function condaActivateLoginScript(
  shellFile: string,
  condaEnv: CondaEnvInfo,
  deps: CondaEnvDeps = {}
): string {
  const execFile = posixSingleQuote(shellFile.replace(/\\/g, '/'))
  const setup = condaActivateCommands(condaEnv, deps)
  if (platformOf(deps) !== 'win32') {
    return [...setup, `exec ${execFile} -i`].join('; ')
  }

  const name = posixSingleQuote(condaEnv.name.trim())
  const condaSh = posixSingleQuote(condaShPath(condaEnv, deps))
  const rcLines = [
    'export CONDA_AUTO_ACTIVATE_BASE=false',
    `if [ -f ${condaSh} ]; then . ${condaSh}; fi`,
    `conda activate ${name} 2>/dev/null || micromamba activate ${name} 2>/dev/null || true`,
    'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi'
  ]
  const printfArgs = rcLines.map((line) => posixSingleQuote(line)).join(' ')
  return [
    ...setup,
    '_dt_rc=$(mktemp "${TMPDIR:-/tmp}/devtool-condaXXXXXX" 2>/dev/null || echo "${TMPDIR:-/tmp}/devtool-conda-$$")',
    `printf '%s\\n' ${printfArgs} > "$_dt_rc"`,
    'echo "rm -f $_dt_rc" >> "$_dt_rc"',
    `exec ${execFile} --rcfile "$_dt_rc" -i`
  ].join('; ')
}

/**
 * Interactive local tabs only. Agent binaries (Pi/Claude/Codex) keep PATH prepend
 * and must not go through this wrapper.
 */
export function wrapInteractiveShellWithCondaActivate(
  spawn: InteractiveShellSpawn,
  condaEnv: CondaEnvInfo | null | undefined,
  deps: CondaEnvDeps = {}
): InteractiveShellSpawn {
  const name = condaEnv?.name?.trim() ?? ''
  const prefix = condaEnv?.prefix?.trim() ?? ''
  if (!name || !prefix) return spawn
  const script = condaActivateLoginScript(spawn.file, { name, prefix }, deps)
  const args =
    platformOf(deps) === 'win32'
      ? ['--login', '-i', '-c', script]
      : ['-l', '-i', '-c', script]
  return { file: spawn.file, args }
}
