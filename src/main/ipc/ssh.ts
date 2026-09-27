import { session } from 'electron'
import type { SshConfig, TunnelConfig } from '../../shared/types'
import type { SshConnectionManager } from '../ssh-connection-manager'
import type { IpcRegistrar } from './registrar'
import { safeId, sshConfig, tunnelConfig } from './schemas'
import { v } from './validate'

/** The browser-tab session of a project, whose traffic the SOCKS proxy carries. */
export function projectBrowserSession(projectId: string): Electron.Session {
  return session.fromPartition(`persist:browser-${projectId}`)
}

/** Route a project's browser tabs through the SOCKS proxy on `port`. */
export async function routeBrowserThroughSocks(projectId: string, port: number): Promise<void> {
  const ses = projectBrowserSession(projectId)
  await ses.setProxy({
    proxyRules: `socks5://127.0.0.1:${port}`,
    proxyBypassRules: '<-loopback>'
  })
  await ses.closeAllConnections()
}

/** Put a project's browser tabs back on a direct connection, ignoring failures. */
export async function routeBrowserDirectQuietly(projectId: string): Promise<void> {
  const ses = projectBrowserSession(projectId)
  await ses.setProxy({ proxyRules: 'direct://' }).catch(() => {})
  await ses.closeAllConnections().catch(() => {})
}

export interface SshDeps {
  sshManager: () => SshConnectionManager
  getProjectTunnel: (projectId: string) => TunnelConfig | undefined
  /** Desired SOCKS state per project (survives reconnects). */
  socksProxyEnabled: Map<string, boolean>
  /** In-flight SOCKS starts, so concurrent enables share one proxy. */
  socksProxyStarting: Map<string, Promise<number>>
  broadcast: (channel: string, ...args: unknown[]) => void
  log: (message: string) => void
}

/** SSH connections, the project tunnel and the per-project SOCKS proxy. */
export function registerSshHandlers(ipc: IpcRegistrar, deps: SshDeps): void {
  const { socksProxyEnabled, socksProxyStarting, broadcast, log } = deps

  ipc.handle('ssh-connect', [safeId, sshConfig], async (_event, projectId, config: SshConfig) => {
    // The tunnel and the SOCKS proxy are restored by the manager's connect
    // path and the 'connected' status handler respectively, so that automatic
    // reconnects go through exactly the same restoration as this one.
    const manager = deps.sshManager()
    await manager.connect(projectId, config, { tunnel: deps.getProjectTunnel(projectId) ?? null })
    manager.startHealthChecks(projectId, config)
  })

  ipc.handle('ssh-disconnect', [safeId, sshConfig], async (_event, projectId, config) => {
    // Reset session proxy before disconnect since stopSocksProxy suppresses the exit event
    if (socksProxyEnabled.get(projectId)) {
      await routeBrowserDirectQuietly(projectId)
      broadcast('socks-proxy-status-changed', projectId, false)
    }
    await deps.sshManager().disconnect(projectId, config)
  })

  ipc.handle('ssh-status', [safeId], (_event, projectId) => deps.sshManager().getStatus(projectId))

  ipc.handle('ssh-set-tunnel', [safeId, sshConfig, v.nullable(tunnelConfig)], async (_event, projectId, config, tunnel) => {
    await deps.sshManager().setTunnel(projectId, config, tunnel)
  })

  ipc.handle('ssh-tunnel-status', [safeId], (_event, projectId) =>
    JSON.parse(JSON.stringify(deps.sshManager().getTunnelState(projectId))))

  ipc.handle('socks-proxy-enable', [safeId, sshConfig], async (_event, projectId, config) => {
    const manager = deps.sshManager()
    log(`socksProxyEnable projectId=${projectId} sshStatus=${manager.getStatus(projectId)}`)
    socksProxyEnabled.set(projectId, true)

    const pending = socksProxyStarting.get(projectId)
    if (pending) {
      const port = await pending
      return { port }
    }

    const startPromise = (async () => {
      log(`socksProxyEnable starting proxy for ${projectId}`)
      const port = await manager.startSocksProxy(projectId, config)
      log(`socksProxyEnable proxy started on port ${port}`)
      // Re-check desired state after async startup — a disable may have raced us
      if (!socksProxyEnabled.get(projectId)) {
        await manager.stopSocksProxy(projectId)
        throw new Error('SOCKS proxy was disabled during startup')
      }
      await routeBrowserThroughSocks(projectId, port)
      log(`socksProxyEnable session configured for ${projectId} port=${port}`)
      broadcast('socks-proxy-status-changed', projectId, true, port)
      return port
    })()

    socksProxyStarting.set(projectId, startPromise)
    try {
      const port = await startPromise
      log(`socksProxyEnable success projectId=${projectId} port=${port}`)
      return { port }
    } catch (err) {
      log(`socksProxyEnable FAILED projectId=${projectId} error=${err instanceof Error ? err.message : String(err)}`)
      socksProxyEnabled.set(projectId, false)
      throw err
    } finally {
      socksProxyStarting.delete(projectId)
    }
  })

  ipc.handle('socks-proxy-disable', [safeId], async (_event, projectId) => {
    socksProxyEnabled.set(projectId, false)
    await deps.sshManager().stopSocksProxy(projectId)
    const ses = projectBrowserSession(projectId)
    await ses.setProxy({ proxyRules: 'direct://' })
    await ses.closeAllConnections()
    broadcast('socks-proxy-status-changed', projectId, false)
  })

  ipc.handle('socks-proxy-status', [safeId], (_event, projectId) => {
    const hasEntry = socksProxyEnabled.has(projectId)
    const enabled = hasEntry ? socksProxyEnabled.get(projectId)! : undefined
    const proxy = deps.sshManager().getSocksProxy(projectId)
    log(`socksProxyStatus projectId=${projectId} hasEntry=${hasEntry} enabled=${enabled} port=${proxy?.port}`)
    return { enabled, port: proxy?.port }
  })
}
