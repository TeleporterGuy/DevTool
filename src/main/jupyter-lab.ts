import { spawn as spawnCb, execFile as execFileCb, type ChildProcess, type ExecFileOptions } from 'child_process'
import fs from 'fs'
import http from 'http'
import net from 'net'
import path from 'path'
import crypto from 'crypto'
import type { CondaEnvInfo } from '../shared/conda'
import {
  JUPYTER_ERRORS,
  buildJupyterlabArgs,
  canReuseJupyterServer,
  condaPythonExecutable,
  jupyterLabUrl,
  redactJupyterTokens,
  type JupyterOpenResult,
  type JupyterServerKey
} from '../shared/jupyter'
import { getShellEnv, type ShellEnvDeps } from './shell-env'

type PathApi = typeof path.win32 | typeof path.posix

type ExecFileFn = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void

export interface JupyterLabDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  path?: PathApi
  existsSync?: (filePath: string) => boolean
  getShellEnv?: typeof getShellEnv
  spawn?: (
    file: string,
    args: string[],
    options: Record<string, unknown>
  ) => ChildProcess
  execFile?: ExecFileFn
  pickFreePort?: () => Promise<number>
  randomToken?: () => string
  httpReady?: (url: string) => Promise<boolean>
  killTree?: (pid: number) => Promise<void>
  log?: (message: string) => void
  /** How long to wait for the server to accept HTTP after spawn. */
  startTimeoutMs?: number
  /** How long to wait for ChildProcess exit before a confirmed tree-kill. */
  killWaitMs?: number
}

export interface JupyterOpenRequest {
  projectId: string
  cwd: string
  condaEnv: CondaEnvInfo
}

interface JupyterServerRecord extends JupyterServerKey {
  pid: number
  port: number
  url: string
  token: string
  child: ChildProcess
  /** Set when our ChildProcess has exited — never tree-kill that pid afterward. */
  exited: boolean
}

function platformOf(deps: JupyterLabDeps): NodeJS.Platform {
  return deps.platform ?? process.platform
}

function pathOf(deps: JupyterLabDeps): PathApi {
  if (deps.path) return deps.path
  return platformOf(deps) === 'win32' ? path.win32 : path.posix
}

function existsOf(deps: JupyterLabDeps): (filePath: string) => boolean {
  return deps.existsSync ?? fs.existsSync
}

/** Bind 127.0.0.1:0, read the OS-assigned port, then close so Jupyter can take it. */
export function pickFreeListenPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, host, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close((err) => {
        if (err) reject(err)
        else if (!port) reject(new Error('no port'))
        else resolve(port)
      })
    })
  })
}

function httpReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve((res.statusCode ?? 500) < 500)
    })
    req.setTimeout(1500, () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

async function killProcessTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawnCb('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('exit', () => resolve())
      killer.on('error', () => resolve())
      setTimeout(resolve, 3000)
    })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 400))
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/**
 * Same spawn env as terminals/agents: conda on PATH, portable Node still first.
 * PYTHONUNBUFFERED so we can read the ready URL without waiting for a flush.
 */
export function buildJupyterSpawnEnv(
  condaEnv: CondaEnvInfo,
  deps: JupyterLabDeps = {}
): Record<string, string> {
  const getEnv = deps.getShellEnv ?? getShellEnv
  const shellDeps: ShellEnvDeps = {
    platform: platformOf(deps),
    env: deps.env,
    existsSync: existsOf(deps),
    path: pathOf(deps)
  }
  const env = getEnv(shellDeps, { condaEnv })
  return { ...env, PYTHONUNBUFFERED: '1' }
}

function execFileOnce(
  execFile: ExecFileFn,
  file: string,
  args: string[],
  options: ExecFileOptions
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '')
      })
    })
  })
}

function lastLogLines(text: string, maxChars = 800): string {
  const redacted = redactJupyterTokens(text).trim()
  if (redacted.length <= maxChars) return redacted
  return redacted.slice(-maxChars)
}

/**
 * One JupyterLab server per project in main. Start, reuse, or replace when
 * the folder or conda env changed. Kill the tree on stop / app quit.
 */
export class JupyterLabManager {
  private readonly servers = new Map<string, JupyterServerRecord>()
  /** One in-flight open per project so two palette clicks do not spawn two servers. */
  private readonly inflight = new Map<string, Promise<JupyterOpenResult>>()
  private readonly deps: JupyterLabDeps

  constructor(deps: JupyterLabDeps = {}) {
    this.deps = deps
  }

  async open(request: JupyterOpenRequest): Promise<JupyterOpenResult> {
    const existing = this.inflight.get(request.projectId)
    if (existing) return existing
    let pending: Promise<JupyterOpenResult>
    pending = this.openSerialized(request).finally(() => {
      if (this.inflight.get(request.projectId) === pending) {
        this.inflight.delete(request.projectId)
      }
    })
    this.inflight.set(request.projectId, pending)
    return pending
  }

  private async openSerialized(request: JupyterOpenRequest): Promise<JupyterOpenResult> {
    const platform = platformOf(this.deps)
    const cwd = request.cwd.trim()
    if (!cwd) return { ok: false, error: JUPYTER_ERRORS.noFolder }
    if (!existsOf(this.deps)(cwd)) {
      return { ok: false, error: `Folder not found: ${cwd}` }
    }

    const wanted: JupyterServerKey = {
      projectId: request.projectId,
      cwd,
      condaPrefix: request.condaEnv.prefix
    }

    const existing = this.servers.get(request.projectId) ?? null
    const owned = existing ? this.childStillOurs(existing) : false
    if (existing && canReuseJupyterServer(existing, wanted, platform, owned)) {
      const readyFn = this.deps.httpReady ?? httpReady
      const stillUp = await readyFn(existing.url) || await readyFn(
        `http://127.0.0.1:${existing.port}/api/status?token=${existing.token}`
      )
      if (stillUp) {
        this.deps.log?.(`jupyter reuse projectId=${request.projectId} port=${existing.port}`)
        return { ok: true, url: existing.url, reused: true, port: existing.port }
      }
    }
    if (existing) await this.stop(request.projectId)

    const python = condaPythonExecutable(request.condaEnv.prefix, {
      platform,
      path: pathOf(this.deps),
      existsSync: existsOf(this.deps)
    })
    if (!python) {
      return { ok: false, error: JUPYTER_ERRORS.noPython(request.condaEnv.prefix) }
    }

    const env = buildJupyterSpawnEnv(request.condaEnv, this.deps)
    const execFile = this.deps.execFile ?? (execFileCb as ExecFileFn)
    const probe = await execFileOnce(
      execFile,
      python,
      ['-c', 'import jupyterlab'],
      { env, cwd, timeout: 20_000, windowsHide: true }
    )
    if (!probe.ok) {
      return { ok: false, error: JUPYTER_ERRORS.noJupyterlab(request.condaEnv.name) }
    }

    const pickPort = this.deps.pickFreePort ?? pickFreeListenPort
    let lastError = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      let port: number
      try {
        port = await pickPort()
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        continue
      }
      const result = await this.spawnServer(request, python, env, port)
      if (result.ok || !/EADDRINUSE|bind/i.test(result.error)) return result
      lastError = result.error
    }
    return { ok: false, error: lastError || JUPYTER_ERRORS.portBind(0) }
  }

  async stop(projectId: string): Promise<void> {
    const record = this.servers.get(projectId)
    if (!record) return
    this.servers.delete(projectId)
    await this.killRecord(record)
  }

  async stopAll(): Promise<void> {
    const ids = [...this.servers.keys()]
    await Promise.all(ids.map((id) => this.stop(id)))
  }

  /** Test helper — current tracked servers. */
  snapshot(): Array<{ projectId: string; pid: number; port: number; url: string; cwd: string; condaPrefix: string }> {
    return [...this.servers.values()].map((item) => ({
      projectId: item.projectId,
      pid: item.pid,
      port: item.port,
      url: item.url,
      cwd: item.cwd,
      condaPrefix: item.condaPrefix
    }))
  }

  private async spawnServer(
    request: JupyterOpenRequest,
    python: string,
    env: Record<string, string>,
    port: number
  ): Promise<JupyterOpenResult> {
    const platform = platformOf(this.deps)
    const token = this.deps.randomToken?.() ?? crypto.randomBytes(24).toString('hex')
    const args = buildJupyterlabArgs(port, token, request.cwd)
    const spawnFn = this.deps.spawn ?? (spawnCb as JupyterLabDeps['spawn'])!
    const expectedUrl = jupyterLabUrl(port, token)
    let output = ''

    let child: ChildProcess
    try {
      child = spawnFn(python, args, {
        cwd: request.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group on Unix so stop() can kill jupyter's children too.
        detached: platform !== 'win32'
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/EADDRINUSE/i.test(message)) return { ok: false, error: JUPYTER_ERRORS.portBind(port) }
      return { ok: false, error: JUPYTER_ERRORS.startFailed(message) }
    }

    const pid = child.pid
    if (!pid) {
      return { ok: false, error: JUPYTER_ERRORS.startFailed('no process id') }
    }

    const append = (chunk: Buffer | string) => {
      output += chunk.toString()
      if (output.length > 64_000) output = output.slice(-32_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    let exitCode: number | null | undefined
    const markExited = (code: number | null) => {
      exitCode = code
      const current = this.servers.get(request.projectId)
      if (current && current.pid === pid) current.exited = true
    }
    child.once('exit', markExited)
    child.once('error', (err) => {
      append(err.message)
      markExited(1)
    })

    const timeoutMs = this.deps.startTimeoutMs ?? 30_000
    const readyFn = this.deps.httpReady ?? httpReady
    const deadline = Date.now() + timeoutMs
    const apiStatusUrl = `http://127.0.0.1:${port}/api/status?token=${token}`
    let httpOk = false

    while (Date.now() < deadline) {
      if (exitCode !== undefined) {
        const detail = lastLogLines(output) || `exit code ${exitCode ?? '?'}`
        return { ok: false, error: JUPYTER_ERRORS.startFailed(detail) }
      }
      // A log line with a URL is not enough — wait until HTTP answers.
      if (await readyFn(expectedUrl) || await readyFn(apiStatusUrl)) {
        httpOk = true
        break
      }
      await new Promise((r) => setTimeout(r, 150))
    }

    if (!httpOk) {
      const diedWhileWaiting = exitCode !== undefined
      await this.killChild({
        pid,
        child,
        exited: exitCode !== undefined
      })
      if (diedWhileWaiting) {
        return { ok: false, error: JUPYTER_ERRORS.startFailed(lastLogLines(output)) }
      }
      return { ok: false, error: JUPYTER_ERRORS.startTimeout }
    }

    const record: JupyterServerRecord = {
      projectId: request.projectId,
      cwd: request.cwd,
      condaPrefix: request.condaEnv.prefix,
      pid,
      port,
      url: expectedUrl,
      token,
      child,
      exited: false
    }
    this.servers.set(request.projectId, record)
    this.deps.log?.(`jupyter start projectId=${request.projectId} port=${port}`)
    return { ok: true, url: expectedUrl, reused: false, port }
  }

  private childStillOurs(record: JupyterServerRecord): boolean {
    if (record.exited) return false
    const child = record.child
    if (child.exitCode != null || child.signalCode) return false
    if (!child.pid || child.pid !== record.pid) return false
    return true
  }

  private async killRecord(record: JupyterServerRecord): Promise<void> {
    this.deps.log?.(`jupyter stop projectId=${record.projectId} port=${record.port}`)
    await this.killChild(record)
  }

  /**
   * Kill through the ChildProcess we spawned. Only tree-kill (taskkill /T,
   * kill(-pid)) when that handle still says the process is ours — a raw pid
   * after exit can already belong to someone else.
   */
  private async killChild(record: Pick<JupyterServerRecord, 'pid' | 'child'> & { exited?: boolean }): Promise<void> {
    const gone = (): boolean =>
      !!(record.exited || record.child.exitCode != null || record.child.signalCode)
    if (gone()) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      record.child.once('exit', finish)
      try {
        record.child.kill('SIGTERM')
      } catch {
        finish()
        return
      }
      if (gone()) {
        finish()
        return
      }
      setTimeout(finish, this.deps.killWaitMs ?? 1000)
    })

    if (gone()) return
    if (!record.child.pid || record.child.pid !== record.pid) return
    const platform = platformOf(this.deps)
    const killTree = this.deps.killTree ?? ((id: number) => killProcessTree(id, platform))
    await killTree(record.pid)
  }
}
