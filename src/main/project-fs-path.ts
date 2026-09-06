import path from 'path'

/**
 * Resolve `relativePath` under `projectCwd` and reject escapes (`..`, other drive).
 * Uses the host path module so Windows accepts `/` and `\` in the relative part.
 */
export function resolveSafeProjectPath(
  projectCwd: string,
  relativePath: string,
  pathApi: typeof path.win32 | typeof path.posix = path
): string {
  const root = pathApi.resolve(projectCwd)
  const resolved = pathApi.resolve(root, relativePath)
  const rel = pathApi.relative(root, resolved)
  if (rel === '') return resolved
  if (pathApi.isAbsolute(rel)) {
    throw new Error('Path traversal not allowed')
  }
  const first = rel.split(pathApi.sep)[0]
  if (first === '..') {
    throw new Error('Path traversal not allowed')
  }
  return resolved
}
