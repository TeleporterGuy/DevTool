/**
 * Per-project file-tree ignore: basename globs, not a .gitignore parser.
 * Patterns live on the project (`fileTreeIgnore`) and are edited in the Files panel.
 */

/** Used when a project has never saved `fileTreeIgnore`. */
export const DEFAULT_FILE_TREE_IGNORE: readonly string[] = [
  '.*',
  'node_modules',
  '__pycache__',
  'dist',
  'build',
  'out',
  'coverage',
  'venv',
  'target'
]

/** Patterns actually applied to a listing. Empty means show everything. */
export function effectiveIgnorePatterns(
  ignore: readonly string[] | undefined,
  includeIgnored: boolean
): readonly string[] {
  if (includeIgnored) return []
  if (ignore === undefined) return DEFAULT_FILE_TREE_IGNORE
  return ignore
}

function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '')
}

/** True if `name` (a single path segment) matches any non-empty, non-comment pattern. */
export function nameMatchesIgnore(
  name: string,
  patterns: readonly string[],
  caseInsensitive: boolean
): boolean {
  for (const raw of patterns) {
    const pattern = raw.trim()
    if (!pattern || pattern.startsWith('#')) continue
    if (globToRegExp(pattern, caseInsensitive).test(name)) return true
  }
  return false
}

export function parseIgnoreText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function formatIgnoreText(patterns: readonly string[]): string {
  return patterns.join('\n')
}
