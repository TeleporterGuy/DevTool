import { spawn } from 'child_process'
import { Transform, type TransformCallback } from 'stream'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'

/**
 * Passes stdout through once the first JSON line arrives, dropping anything the
 * remote login shell printed before `claude` took over (motd, rc-file echoes,
 * "no job control" chatter). The stream-json protocol is one JSON object per
 * line, so a stray banner line would otherwise be parsed as a protocol frame.
 */
export class JsonLineGate extends Transform {
  private open = false
  private buffer = ''

  constructor(private readonly onDropped?: (line: string) => void) {
    super()
  }

  _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.open) {
      callback(null, chunk)
      return
    }
    this.buffer += chunk.toString()
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      if (line.trimStart().startsWith('{')) {
        this.open = true
        const rest = this.buffer
        this.buffer = ''
        callback(null, rest)
        return
      }
      if (line.trim()) this.onDropped?.(line)
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
    }
    // A partial line that already looks like JSON can pass: the first frame may be large.
    if (this.buffer.trimStart().startsWith('{')) {
      this.open = true
      const rest = this.buffer
      this.buffer = ''
      callback(null, rest)
      return
    }
    callback()
  }

  _flush(callback: TransformCallback): void {
    if (this.open && this.buffer) this.push(this.buffer)
    this.buffer = ''
    callback()
  }
}

/**
 * Env the SDK adds on top of what we gave it (entrypoint, SDK version, …). A
 * remote `claude` only sees what we forward, and host-local values like PATH or
 * HOME must not leak across.
 */
export function sdkAddedEnv(
  spawnEnv: Record<string, string | undefined>,
  baseEnv: Record<string, string | undefined>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(spawnEnv)) {
    if (value === undefined || baseEnv[key] === value) continue
    if (!/^(CLAUDE|ANTHROPIC|MCP|DISABLE|ENABLE|MAX_|BASH_)/.test(key)) continue
    out[key] = value
  }
  return out
}

export interface RemoteCommand {
  file: string
  args: string[]
}

/**
 * A `spawnClaudeCodeProcess` that runs `claude` on the project's host over the
 * existing ssh connection: stdin/stdout are the protocol, so a plain non-tty ssh
 * channel carries it. When the connection drops the process ends, the turn ends
 * with it, and the next send starts a fresh process that resumes the session.
 */
export function createRemoteSpawner(
  buildCommand: (claudeArgs: string[], env: Record<string, string>) => RemoteCommand,
  baseEnv: Record<string, string | undefined>,
  hooks: { onStderr?: (text: string) => void; onDropped?: (line: string) => void; onSpawn?: (command: RemoteCommand) => void } = {}
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions) => {
    const command = buildCommand(options.args, sdkAddedEnv(options.env, baseEnv))
    hooks.onSpawn?.(command)
    const child = spawn(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const gate = new JsonLineGate(hooks.onDropped)
    child.stdout.pipe(gate)
    child.stderr.on('data', (data: Buffer) => hooks.onStderr?.(data.toString()))
    const onAbort = (): void => {
      if (!child.killed) child.kill('SIGTERM')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.once('exit', () => options.signal?.removeEventListener('abort', onAbort))

    const process: SpawnedProcess = {
      stdin: child.stdin,
      stdout: gate,
      get killed() { return child.killed },
      get exitCode() { return child.exitCode },
      get signalCode() { return child.signalCode },
      kill: (signal) => child.kill(signal),
      on: (event: 'exit' | 'error', listener: (...args: never[]) => void) => {
        child.on(event, listener as (...args: unknown[]) => void)
      },
      once: (event: 'exit' | 'error', listener: (...args: never[]) => void) => {
        child.once(event, listener as (...args: unknown[]) => void)
      },
      off: (event: 'exit' | 'error', listener: (...args: never[]) => void) => {
        child.off(event, listener as (...args: unknown[]) => void)
      }
    } as SpawnedProcess
    return process
  }
}
