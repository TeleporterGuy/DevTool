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

/**
 * Swallow only EIO/EPIPE in main. Anything else is rethrown so it still
 * surfaces (Electron dialog / process exit). Call once at bootstrap.
 */
export function installBrokenPipeUncaughtHandler(
  target: NodeJS.EventEmitter = process
): void {
  target.on('uncaughtException', (err: unknown) => {
    if (isBrokenPipeError(err)) return
    throw err
  })
}
