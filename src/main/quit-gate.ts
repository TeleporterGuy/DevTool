/**
 * Electron `before-quit` is sync. If we `void shutdown()`, the app can exit
 * before Jupyter's process-tree kill finishes. This gate preventDefault's the
 * first quit, awaits shutdown, then calls exit(). A second before-quit (from
 * app.exit itself) is ignored so we do not loop.
 */
export interface QuitGateHooks {
  prepare: () => void
  shutdown: () => Promise<void>
  exit: () => void
}

export function createQuitGate(hooks: QuitGateHooks): (event: { preventDefault: () => void }) => void {
  let started = false
  return (event) => {
    if (started) return
    event.preventDefault()
    started = true
    hooks.prepare()
    void Promise.resolve()
      .then(() => hooks.shutdown())
      .finally(() => hooks.exit())
  }
}
