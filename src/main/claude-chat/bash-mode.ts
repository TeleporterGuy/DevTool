import { spawn } from 'child_process'

/** How to run one `!command`: a shell with `-c`, locally or through ssh. */
export interface BashSpawn {
  file: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface BashResult {
  stdout: string
  stderr: string
  /** Null when it was killed (timeout) or never started. */
  exitCode: number | null
}

/** The CLI's bash mode gives a command two minutes; so do we. */
export const BASH_TIMEOUT_MS = 120_000
/** Per stream. Past this the rest is dropped; the timeline and Claude get the head. */
export const BASH_OUTPUT_LIMIT = 100_000

/**
 * Run a `!command` with stdin closed (nothing can wait on a keyboard that isn't
 * there) and collect what it printed. Never rejects: a failure to start comes
 * back as stderr, as a shell would print it.
 */
export function runBash(spec: BashSpawn, timeoutMs = BASH_TIMEOUT_MS): Promise<BashResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (exitCode: number | null, extra?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr: extra ? `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}${extra}` : stderr, exitCode })
    }
    const append = (current: string, chunk: Buffer): string =>
      current.length >= BASH_OUTPUT_LIMIT ? current : (current + chunk.toString()).slice(0, BASH_OUTPUT_LIMIT)

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spec.file, spec.args, {
        cwd: spec.cwd,
        env: spec.env as NodeJS.ProcessEnv | undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: null })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null, `Stopped after ${Math.round(timeoutMs / 1000)}s.`)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.on('error', (err) => finish(null, err.message))
    child.on('close', (code) => finish(code))
  })
}
