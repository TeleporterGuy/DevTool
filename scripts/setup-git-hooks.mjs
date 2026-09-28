#!/usr/bin/env node
/**
 * `prepare` hook: point git at the tracked .githooks/ directory.
 *
 * Only acts when this package directory is the top level of a git work tree, so it is
 * a no-op for tarball installs, CI checkouts without git, or a nested install inside
 * some other repository. Never fails the install.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

try {
  if (!existsSync(join(root, '.githooks'))) process.exit(0)
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
  if (realpathSync(top) !== realpathSync(root)) process.exit(0)
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' })
} catch {
  // Not a git checkout, or git is not installed: nothing to set up.
}
