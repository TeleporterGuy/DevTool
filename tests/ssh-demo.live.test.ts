import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { HookServer } from '../src/main/hook-server'
import { SshConnectionManager } from '../src/main/ssh-connection-manager'
import { HOOK_TAB_ID_HEADER, HOOK_TOKEN_HEADER } from '../src/shared/hook-protocol'
import {
  buildRemotePiExtensionScript,
  PI_REMOTE_EXTENSION_DIR
} from '../src/main/pi-extension-injector'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/**
 * Live SSH check against a disposable OpenSSH daemon.
 * Skipped unless DEMO_SSH=1. Host/user/key come from the environment only —
 * do not commit those values (or any real private key) into this file.
 *
 *   DEMO_SSH=1 DEMO_SSH_KEY=/path/to/ed25519 npm test -- tests/ssh-demo.live.test.ts
 *
 * Default target is localhost:2222 (same machine as the test). Pointing this
 * at a real workstation overwrites `$HOME/.devtool-remote` unless the host is
 * loopback; the write test is skipped for non-loopback hosts.
 */
const enabled = process.env.DEMO_SSH === '1'

const SSH_CONFIG = {
  host: process.env.DEMO_SSH_HOST ?? '127.0.0.1',
  port: Number(process.env.DEMO_SSH_PORT ?? 2222),
  username: process.env.DEMO_SSH_USER ?? os.userInfo().username,
  keyFile: process.env.DEMO_SSH_KEY ?? '/tmp/demo-sshd/user_ed25519',
  remoteDir: process.env.DEMO_SSH_DIR ?? os.homedir()
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function post(
  port: number,
  headers: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/hook/working',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.write('{}')
    req.end()
  })
}

describe.skipIf(!enabled)('demo SSH (DEMO_SSH=1)', () => {
  let socketDir: string
  let hook: HookServer
  let manager: SshConnectionManager
  const sourceExt = path.join(os.tmpdir(), `pi-ext-live-${Date.now()}.mjs`)

  /** Same ssh.exe as ControlMaster. Git ssh on Windows cannot mux a new session (`-S`). */
  function remoteCommandArgs(command: string): string[] {
    const args: string[] = [
      '-o', 'BatchMode=yes',
      '-p', String(SSH_CONFIG.port),
      '-o', 'StrictHostKeyChecking=accept-new'
    ]
    if (process.platform !== 'win32') {
      args.push('-S', manager.getSocketPath('demo'), '-o', 'ControlMaster=no')
    }
    if (SSH_CONFIG.keyFile) {
      args.push('-i', SSH_CONFIG.keyFile)
    }
    args.push(`${SSH_CONFIG.username}@${SSH_CONFIG.host}`, command)
    return args
  }

  async function remoteExec(command: string): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(manager.getSshCommand(), remoteCommandArgs(command), { timeout: 15000 })
  }

  beforeAll(async () => {
    if (!fs.existsSync(SSH_CONFIG.keyFile!)) {
      throw new Error('DEMO_SSH_KEY file is missing (set the env var to a key path; do not commit the key)')
    }
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-live-'))
    hook = new HookServer()
    await hook.start()
    manager = new SshConnectionManager(socketDir, hook.getPort())
    fs.writeFileSync(sourceExt, 'export default function () {}\n')
  }, 15000)

  afterAll(async () => {
    await manager?.disconnectAll()
    await hook?.stop()
    fs.rmSync(socketDir, { recursive: true, force: true })
    fs.rmSync(sourceExt, { force: true })
  })

  it('connects and 0700-protects the ssh dir', async () => {
    await manager.connect('demo', SSH_CONFIG)
    expect(manager.getStatus('demo')).toBe('connected')
    expect(manager.getRemotePort('demo')).toBeGreaterThan(0)

    if (process.platform !== 'win32') {
      expect(fs.statSync(socketDir).mode & 0o777).toBe(0o700)
    }
  }, 20000)

  it('rejects spoofed hook POSTs and accepts the token, including via -R', async () => {
    const remotePort = manager.getRemotePort('demo')
    expect(remotePort).toBeDefined()

    expect(await post(hook.getPort(), { [HOOK_TAB_ID_HEADER]: 'tab-1' })).toBe(401)
    expect(await post(hook.getPort(), {
      [HOOK_TAB_ID_HEADER]: 'tab-1',
      [HOOK_TOKEN_HEADER]: hook.getToken()
    })).toBe(200)

    const { stdout: denied } = await remoteExec(
      `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:${remotePort}/hook/working -H '${HOOK_TAB_ID_HEADER}: tab-1' -d '{}'`
    )
    expect(denied.trim()).toBe('401')

    const { stdout: ok } = await remoteExec(
      `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:${remotePort}/hook/working -H '${HOOK_TAB_ID_HEADER}: tab-1' -H '${HOOK_TOKEN_HEADER}: ${hook.getToken()}' -d '{}'`
    )
    expect(ok.trim()).toBe('200')
  }, 20000)

  it.skipIf(!isLoopbackHost(SSH_CONFIG.host))(
    'writes the Pi extension under $HOME/.devtool-remote with mode 0700',
    async () => {
      const sshArgs = manager.buildSpawnArgs(
        'demo',
        SSH_CONFIG,
        'true',
        undefined,
        undefined,
        `${buildRemotePiExtensionScript(sourceExt)} && `,
        SSH_CONFIG.remoteDir
      )
      await execFileAsync(manager.getSshCommand(), sshArgs, { timeout: 15000 })

      const remoteDir = path.join(os.homedir(), PI_REMOTE_EXTENSION_DIR)
      const remoteFile = path.join(remoteDir, 'pi-status-extension.mjs')
      expect(fs.existsSync(remoteFile)).toBe(true)
      if (process.platform !== 'win32') {
        expect(fs.statSync(remoteDir).mode & 0o777).toBe(0o700)
      }
    },
    15000
  )

  it('reconnects after an explicit disconnect', async () => {
    await manager.disconnect('demo', SSH_CONFIG)
    await manager.connect('demo', SSH_CONFIG)
    expect(manager.getStatus('demo')).toBe('connected')
  }, 20000)
})
