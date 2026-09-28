/**
 * Closed-pipe errors after a child is killed (interrupt / restart / shutdown).
 * Node emits these asynchronously on stdin/stdout; without a listener they
 * become uncaught exceptions in Electron main.
 */

export function isBrokenPipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 'EIO' || code === 'EPIPE'
}

/** No-op stream 'error' handler. Do not console.error — that write can EIO too. */
export function ignoreStreamError(_err: Error): void {
  /* EPIPE/EIO after teardown */
}

/**
 * Attach a listener so EPIPE/EIO on a helper pipe is not uncaught.
 * Safe to call on any EventEmitter-like stream (stdin/stdout/stderr).
 */
export function ignoreStreamErrors(
  stream: { on?: (event: string, listener: (err: Error) => void) => unknown } | null | undefined
): void {
  if (!stream || typeof stream.on !== 'function') return
  stream.on('error', ignoreStreamError)
}

/**
 * Write JSON to the helper. try/catch covers sync throws; the callback
 * covers the usual async EPIPE/EIO after the process is already gone.
 */
export function writeIgnoringBrokenPipe(
  stdin: { write: (chunk: string, cb?: (err?: Error | null) => void) => unknown },
  chunk: string
): void {
  try {
    stdin.write(chunk, (err) => {
      if (!err || isBrokenPipeError(err)) return
      // Other write failures: helper is gone. Do not throw.
    })
  } catch {
    // Sync throw from a destroyed stream.
  }
}

type UncaughtListener = (err: unknown) => void

/**
 * Swallow only EIO/EPIPE in main. Do not rethrow other errors — a throw
 * from this listener aborts instead of Electron's recoverable dialog.
 *
 * Existing `uncaughtException` listeners (Electron's dialog) are wrapped
 * so they still run for everything except broken pipes. Call once at bootstrap.
 *
 * Tests can pass `onOther` to observe non-pipe errors without Electron.
 */
export function installBrokenPipeUncaughtHandler(
  target: NodeJS.EventEmitter = process,
  onOther?: (err: unknown) => void
): void {
  const previous = target.listeners('uncaughtException').slice() as UncaughtListener[]
  target.removeAllListeners('uncaughtException')
  target.on('uncaughtException', (err: unknown) => {
    if (isBrokenPipeError(err)) return
    if (onOther) {
      onOther(err)
      return
    }
    for (const listener of previous) {
      listener(err)
    }
  })
}
