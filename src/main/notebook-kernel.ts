import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { CondaEnvInfo } from '../shared/conda'
import {
  NOTEBOOK_ERROR_MISSING_JUPYTER,
  NOTEBOOK_ERROR_NO_CONDA,
  NOTEBOOK_ERROR_NO_PYTHON,
  parseKernelEventLine,
  type NotebookKernelEvent
} from '../shared/notebook'
import { condaPythonExecutable, type CondaEnvDeps } from './conda-env'
import { getShellEnv, type ShellEnvDeps } from './shell-env'

export type NotebookKernelPrepareOk = {
  ok: true
  python: string
  args: string[]
  env: Record<string, string>
  cwd: string
  helperPath: string
}

export type NotebookKernelPrepareErr = {
  ok: false
  code: 'no-conda' | 'no-python' | 'no-helper'
  error: string
}

export type NotebookKernelPrepareResult = NotebookKernelPrepareOk | NotebookKernelPrepareErr

export interface NotebookKernelPrepareDeps extends CondaEnvDeps, ShellEnvDeps {
  helperExistsSync?: (filePath: string) => boolean
}

/**
 * Path to the bundled jupyter_client helper. Same asarUnpack trick as the Pi
 * status extension: an external python cannot read files inside app.asar.
 */
export function notebookKernelHelperPath(): string {
  const p = path.join(__dirname, 'notebook-kernel.py')
  const packed = `app.asar${path.sep}`
  return p.includes(packed) ? p.replace(packed, `app.asar.unpacked${path.sep}`) : p
}

export function prepareNotebookKernelSpawn(
  condaEnv: CondaEnvInfo | null | undefined,
  cwd: string,
  deps: NotebookKernelPrepareDeps = {},
  helperPath = notebookKernelHelperPath()
): NotebookKernelPrepareResult {
  const name = condaEnv?.name?.trim() ?? ''
  const prefix = condaEnv?.prefix?.trim() ?? ''
  if (!name || !prefix) {
    return { ok: false, code: 'no-conda', error: NOTEBOOK_ERROR_NO_CONDA }
  }

  const python = condaPythonExecutable(prefix, deps)
  if (!python) {
    return { ok: false, code: 'no-python', error: NOTEBOOK_ERROR_NO_PYTHON }
  }

  const helperExists = deps.helperExistsSync ?? fs.existsSync
  if (!helperExists(helperPath)) {
    return { ok: false, code: 'no-helper', error: 'Notebook kernel helper is missing from the app install.' }
  }

  const env = {
    ...getShellEnv(deps, { condaEnv }),
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  }

  return {
    ok: true,
    python,
    args: ['-u', helperPath],
    env,
    cwd,
    helperPath
  }
}

export type NotebookKernelListener = (tabId: string, event: NotebookKernelEvent) => void

interface KernelSession {
  child: ChildProcessWithoutNullStreams
  buffer: string
}

/**
 * One jupyter_client helper process per notebook tab.
 * Local conda env only — remote SSH notebooks are out of scope.
 */
export class NotebookKernelManager {
  private sessions = new Map<string, KernelSession>()
  private listener: NotebookKernelListener | null = null

  onEvent(listener: NotebookKernelListener): void {
    this.listener = listener
  }

  private emit(tabId: string, event: NotebookKernelEvent): void {
    this.listener?.(tabId, event)
  }

  start(
    tabId: string,
    condaEnv: CondaEnvInfo | null | undefined,
    cwd: string
  ): { error?: string; code?: string } {
    this.shutdown(tabId)
    const prepared = prepareNotebookKernelSpawn(condaEnv, cwd)
    if (!prepared.ok) {
      this.emit(tabId, { event: 'fail', code: prepared.code, message: prepared.error })
      return { error: prepared.error, code: prepared.code }
    }

    this.emit(tabId, { event: 'status', execution_state: 'starting' })

    const child = spawn(prepared.python, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    const session: KernelSession = { child, buffer: '' }
    this.sessions.set(tabId, session)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      session.buffer += chunk
      const lines = session.buffer.split('\n')
      session.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseKernelEventLine(line)
        if (event) this.emit(tabId, event)
      }
    })

    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) {
        // Keep stderr for debugging; do not surface as cell output.
        // A missing-module traceback still arrives as a fail JSON event on stdout.
      }
    })

    child.on('exit', (code, signal) => {
      if (this.sessions.get(tabId)?.child !== child) return
      this.sessions.delete(tabId)
      if (code === 2) {
        // Helper already emitted a fail event for missing jupyter_client / ipykernel.
        this.emit(tabId, { event: 'status', execution_state: 'dead' })
        return
      }
      const reason = signal
        ? `Kernel exited (${signal}).`
        : code
          ? `Kernel exited (code ${code}). ${NOTEBOOK_ERROR_MISSING_JUPYTER}`
          : 'Kernel exited.'
      this.emit(tabId, { event: 'dead', message: reason })
      this.emit(tabId, { event: 'status', execution_state: 'dead' })
    })

    child.on('error', (err) => {
      if (this.sessions.get(tabId)?.child !== child) return
      this.sessions.delete(tabId)
      this.emit(tabId, { event: 'fail', code: 'spawn', message: err.message || 'Could not start Python.' })
      this.emit(tabId, { event: 'status', execution_state: 'dead' })
    })

    return {}
  }

  execute(tabId: string, requestId: string, code: string): { error?: string } {
    const session = this.sessions.get(tabId)
    if (!session) return { error: 'Kernel is not running. Click Restart kernel.' }
    try {
      session.child.stdin.write(`${JSON.stringify({ cmd: 'execute', id: requestId, code })}\n`)
      return {}
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { error: message }
    }
  }

  interrupt(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (!session) return
    try {
      session.child.stdin.write(`${JSON.stringify({ cmd: 'interrupt' })}\n`)
    } catch {
      // Process already gone.
    }
  }

  shutdown(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.sessions.delete(tabId)
    try {
      session.child.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`)
    } catch {
      // Ignore.
    }
    const child = session.child
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Ignore.
      }
    }, 2000)
    child.once('exit', () => clearTimeout(timer))
  }

  shutdownAll(): void {
    for (const tabId of [...this.sessions.keys()]) {
      this.shutdown(tabId)
    }
  }

  has(tabId: string): boolean {
    return this.sessions.has(tabId)
  }
}
