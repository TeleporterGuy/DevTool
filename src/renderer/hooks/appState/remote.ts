import { useCallback } from 'react'
import { isRemoteProject } from '../../../shared/types'
import type { Project, SshConfig } from '../../../shared/types'

export type ConnectSsh = (projectId: string, sshConfig: SshConfig) => ReturnType<typeof window.api.sshConnect>

export function useConnectSsh(): ConnectSsh {
  return useCallback((projectId: string, sshConfig: SshConfig) => {
    return window.api.sshConnect(projectId, sshConfig)
  }, [])
}

/**
 * Landing on a remote project (selecting it, switching into one of its tasks,
 * restoring a tab) opens its SSH master unless one is already up or on its way.
 * Local projects, and remote ones without an SSH config, are left alone.
 */
export function ensureRemoteConnected(
  projectId: string,
  project: Project | null | undefined,
  connectSsh: ConnectSsh
): void {
  if (!project || !isRemoteProject(project) || !project.ssh) return
  const ssh = project.ssh
  window.api.sshStatus(projectId).then(status => {
    if (status !== 'connected' && status !== 'connecting') {
      connectSsh(projectId, ssh).catch(() => {})
    }
  })
}
