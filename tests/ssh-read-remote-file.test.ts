import { describe, it, expect } from 'vitest'
import path from 'path'
import { buildReadRemoteFileArgs } from '../src/main/ssh-connection-manager'

const SOCKET_DIR = '/tmp/devtool-sockets'

const SSH_CONFIG = {
  host: 'host.example',
  port: 22,
  username: 'user',
  keyFile: undefined,
  remoteDir: '/srv/app'
}

describe('buildReadRemoteFileArgs', () => {
  it('joins remote dir with relative path and uses cat', () => {
    const args = buildReadRemoteFileArgs(SOCKET_DIR, 'proj-1', SSH_CONFIG, 'README.md')
    expect(args).toContain('cat')
    const lastArg = args[args.length - 1]
    expect(lastArg).toMatch(/\/srv\/app\/README\.md/)
  })

  it('quotes paths containing spaces', () => {
    const args = buildReadRemoteFileArgs(SOCKET_DIR, 'proj-1', { ...SSH_CONFIG, remoteDir: '/srv/my app' }, 'README.md')
    const cmd = args.slice(args.indexOf('cat')).join(' ')
    expect(cmd).toContain('cat')
    expect(cmd).toMatch(/'\/srv\/my app\/README\.md'|"\/srv\/my app\/README\.md"/)
  })

  it('uses the per-project control socket', () => {
    const args = buildReadRemoteFileArgs(SOCKET_DIR, 'proj-1', SSH_CONFIG, 'README.md')
    const sFlag = args.indexOf('-S')
    expect(sFlag).toBeGreaterThanOrEqual(0)
    expect(args[sFlag + 1]).toContain('proj-1')
  })

  it('targets the configured user@host', () => {
    const args = buildReadRemoteFileArgs(SOCKET_DIR, 'proj-1', SSH_CONFIG, 'README.md')
    expect(args.some(a => a === 'user@host.example')).toBe(true)
  })

  it('uses the user\'s own known_hosts and leaves identity selection to ssh', () => {
    const args = buildReadRemoteFileArgs(SOCKET_DIR, 'proj-1', SSH_CONFIG, 'README.md')
    expect(args).toContain('StrictHostKeyChecking=accept-new')
    expect(args).not.toContain('UserKnownHostsFile')
    expect(args).not.toContain('IdentitiesOnly=yes')
  })

  it('passes the key file with -i when configured', () => {
    const args = buildReadRemoteFileArgs(
      SOCKET_DIR,
      'proj-1',
      { ...SSH_CONFIG, keyFile: '/home/user/.ssh/id_ed25519' },
      'README.md'
    )
    expect(args).toContain('-i')
    expect(args).toContain('/home/user/.ssh/id_ed25519')
    expect(args).not.toContain('IdentitiesOnly=yes')
  })
})
