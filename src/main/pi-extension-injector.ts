import fs from 'fs'
import path from 'path'

/**
 * Injection helpers for the pi status extension (resources/pi-status-extension.mjs).
 *
 * Unlike Claude (which mutates the project's .claude/settings.local.json), pi loads
 * our status extension via a `-e <path>` CLI flag. Locally that path is the file the
 * build copies next to the main bundle; remotely we base64-write the same file under
 * the remote home (reusing the SSH command channel, exactly like Claude's remote hooks).
 */

/** Remote dir (under $HOME) for the copied extension. Mode 0700 on the remote. */
export const PI_REMOTE_EXTENSION_DIR = '.devtool-remote'

export const PI_REMOTE_EXTENSION_FILE = 'pi-status-extension.mjs'

/**
 * Path expression the remote bash login shell expands. Must not be single-quoted
 * in `buildSpawnArgs` or `$HOME` stays literal.
 */
export function piExtensionRemotePath(): string {
  return `$HOME/${PI_REMOTE_EXTENSION_DIR}/${PI_REMOTE_EXTENSION_FILE}`
}

/**
 * Absolute path to the bundled pi status extension (copied to out/main at build time).
 *
 * In a packaged app __dirname lives inside app.asar, but pi is an external process that
 * can't read paths inside the asar archive — so the file is unpacked (see package.json
 * `asarUnpack`) and we point at its real on-disk location under app.asar.unpacked. In dev
 * there is no asar, so the replacement is a no-op.
 */
export function piExtensionLocalPath(): string {
  const p = path.join(__dirname, 'pi-status-extension.mjs')
  const packed = `app.asar${path.sep}`
  return p.includes(packed) ? p.replace(packed, `app.asar.unpacked${path.sep}`) : p
}

/** Shell-quote a value for safe interpolation into a remote shell command. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Build a shell script that writes the pi status extension under the remote home.
 * Uses $HOME (not /tmp) so a shared host cannot plant the file via a world-writable
 * directory. `chmod 700` makes the dir owner-only.
 */
export function buildRemotePiExtensionScript(sourcePath: string = piExtensionLocalPath()): string {
  const b64 = fs.readFileSync(sourcePath).toString('base64')
  const dirExpr = `"$HOME/${PI_REMOTE_EXTENSION_DIR}"`
  const homeRel = `~/${PI_REMOTE_EXTENSION_DIR}/${PI_REMOTE_EXTENSION_FILE}`
  return `mkdir -p ${dirExpr} && chmod 700 ${dirExpr} && python3 -c "
import base64, os
path = os.path.expanduser(${shellQuote(homeRel)})
open(path, 'wb').write(base64.b64decode('${b64}'))
"`
}
