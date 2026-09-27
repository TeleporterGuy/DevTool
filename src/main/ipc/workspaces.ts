import type { SshConfig, WorkspaceDeleteRequest, WorkspaceDeleteResult } from '../../shared/types'
import type { RemoteWorkspaceManager } from '../remote-workspace-manager'
import type { WorkspaceManager } from '../workspace-manager'
import type { IpcRegistrar } from './registrar'
import { workspaceCreateRequest, workspaceDeleteRequest, workspaceListBranchesRequest } from './schemas'

export interface WorkspaceDeps {
  workspaceManager: WorkspaceManager
  remoteWorkspaceManager: RemoteWorkspaceManager
  ensureSshConnected: (projectId: string, sshConfig: SshConfig) => Promise<void>
  socketPath: (projectId: string) => string
  /** Shared with the idle sweep. */
  deleteWorkspace: (request: WorkspaceDeleteRequest) => Promise<WorkspaceDeleteResult>
}

/**
 * Git worktree workspaces for tasks.
 *
 * `projectDir` is not allow-listed: the new-task composer lists branches and
 * creates a worktree for a directory picked with "Use a directory…" *before*
 * the ad-hoc project that will own it is written to the store, and a
 * cancelled create deletes a worktree no task ever recorded. Deletion is
 * guarded by WorkspaceManager itself (the path must be a registered worktree
 * of the repository).
 */
export function registerWorkspaceHandlers(ipc: IpcRegistrar, deps: WorkspaceDeps): void {
  ipc.handle('workspace-list-branches', [workspaceListBranchesRequest], async (_event, request) => {
    if (request.sshConfig && request.projectId) {
      await deps.ensureSshConnected(request.projectId, request.sshConfig)
      return deps.remoteWorkspaceManager.listBranches(deps.socketPath(request.projectId), {
        ...request,
        projectId: request.projectId,
        sshConfig: request.sshConfig
      })
    }
    return deps.workspaceManager.listBranches(request.projectDir)
  })

  ipc.handle('workspace-create', [workspaceCreateRequest], async (_event, request) => {
    const { projectId, sshConfig } = request
    const result = sshConfig && projectId
      ? await (async () => {
          await deps.ensureSshConnected(projectId, sshConfig)
          return deps.remoteWorkspaceManager.create(deps.socketPath(projectId), {
            ...request,
            projectId,
            sshConfig
          })
        })()
      : await deps.workspaceManager.create(request.projectDir, request.name, request.baseBranch)
    return { ...result, baseBranch: request.baseBranch }
  })

  ipc.handle('workspace-delete', [workspaceDeleteRequest], (_event, request) => deps.deleteWorkspace(request))
}
