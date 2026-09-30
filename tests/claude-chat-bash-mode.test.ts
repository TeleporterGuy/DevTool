import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { bashContextBlocks, emptyChatState, reduceChat, type ChatEvent, type ChatState } from '../src/shared/claude-chat'
import { runBash } from '../src/main/claude-chat/bash-mode'
import { readPermissionSettings, settingsPath, updatePermissionRule } from '../src/main/claude-chat/permission-settings'

function fold(events: ChatEvent[], state: ChatState = emptyChatState()): ChatState {
  return events.reduce(reduceChat, state)
}

describe('chat bash mode', () => {
  it('shows a !command running, then its output, until it goes out with a message', () => {
    let state = fold([{ t: 'bash', id: 'b1', command: 'ls' }])
    expect(state.items).toEqual([{ kind: 'bash', id: 'b1', command: 'ls', running: true }])
    // Your own command doesn't start a turn.
    expect(state.busy).toBe(false)
    state = fold([{ t: 'bash-done', id: 'b1', stdout: 'a\nb\n', stderr: '', exitCode: 0 }], state)
    expect(state.items[0]).toMatchObject({ running: false, stdout: 'a\nb\n', exitCode: 0, pendingContext: true })
    state = fold([{ t: 'bash-sent', ids: ['b1'] }], state)
    expect(state.items[0]).toMatchObject({ pendingContext: false })
  })

  it('rebuilds !commands from history, both as DevTool sends them and as the CLI writes them', () => {
    const [context] = bashContextBlocks('npm test', 'ok\n', 'warn', 1)
    const state = fold([{
      t: 'history',
      messages: [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: context }, { type: 'text', text: 'why the warning?' }] } },
        { type: 'user', uuid: 'u2', message: { role: 'user', content: '<bash-input>pwd</bash-input>' } },
        { type: 'user', uuid: 'u3', message: { role: 'user', content: '<bash-stdout>/repo</bash-stdout><bash-stderr></bash-stderr>' } }
      ]
    }])
    expect(state.items.map((item) => item.kind)).toEqual(['bash', 'user', 'bash'])
    expect(state.items[0]).toMatchObject({ command: 'npm test', stdout: 'ok\n', stderr: 'warn', exitCode: 1 })
    expect(state.items[1]).toMatchObject({ text: 'why the warning?' })
    expect(state.items[2]).toMatchObject({ command: 'pwd', stdout: '/repo', stderr: '' })
  })

  it.skipIf(process.platform === 'win32')('runs a command with stdin closed and reports its exit code', async () => {
    const result = await runBash({ file: '/bin/sh', args: ['-c', 'echo out; echo err >&2; read x; exit 3'] })
    expect(result).toEqual({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 })
  })

  it.skipIf(process.platform === 'win32')('kills a command that runs past the timeout', async () => {
    const result = await runBash({ file: '/bin/sh', args: ['-c', 'sleep 5'] }, 100)
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toMatch(/Stopped after/)
  })

  it('reports a shell that cannot start as stderr', async () => {
    const result = await runBash({ file: path.join(os.tmpdir(), 'no-such-shell-devtool'), args: [] })
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toMatch(/ENOENT/)
  })
})

describe('chat /permissions settings', () => {
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-perms-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('adds and removes rules and leaves the rest of the file alone', async () => {
    const cwd = tempDir()
    const env = { CLAUDE_CONFIG_DIR: tempDir() }
    const local = settingsPath('localSettings', cwd, env)
    fs.mkdirSync(path.dirname(local), { recursive: true })
    fs.writeFileSync(local, JSON.stringify({ hooks: { Stop: [] }, permissions: { allow: ['Read'], defaultMode: 'plan' } }))

    await updatePermissionRule(cwd, 'localSettings', 'allow', ' Bash(npm test:*) ', 'add', env)
    await updatePermissionRule(cwd, 'localSettings', 'allow', 'Bash(npm test:*)', 'add', env)
    await updatePermissionRule(cwd, 'userSettings', 'deny', 'WebFetch', 'add', env)
    let sources = await readPermissionSettings(cwd, env)
    expect(sources.find((s) => s.kind === 'localSettings')).toMatchObject({ allow: ['Read', 'Bash(npm test:*)'], defaultMode: 'plan' })
    expect(sources.find((s) => s.kind === 'userSettings')).toMatchObject({ exists: true, deny: ['WebFetch'] })
    expect(sources.find((s) => s.kind === 'projectSettings')).toMatchObject({ exists: false, allow: [] })

    await updatePermissionRule(cwd, 'localSettings', 'allow', 'Read', 'remove', env)
    await updatePermissionRule(cwd, 'localSettings', 'allow', 'Bash(npm test:*)', 'remove', env)
    expect(JSON.parse(fs.readFileSync(local, 'utf8'))).toEqual({ hooks: { Stop: [] }, permissions: { defaultMode: 'plan' } })
    sources = await readPermissionSettings(cwd, env)
    expect(sources.find((s) => s.kind === 'localSettings')?.allow).toEqual([])
  })

  it("refuses to rewrite a file that doesn't parse", async () => {
    const cwd = tempDir()
    const env = { CLAUDE_CONFIG_DIR: tempDir() }
    const project = settingsPath('projectSettings', cwd, env)
    fs.mkdirSync(path.dirname(project), { recursive: true })
    fs.writeFileSync(project, '{ "permissions": ')
    await expect(updatePermissionRule(cwd, 'projectSettings', 'allow', 'Read', 'add', env)).rejects.toThrow()
    expect(fs.readFileSync(project, 'utf8')).toBe('{ "permissions": ')
    const sources = await readPermissionSettings(cwd, env)
    expect(sources.find((s) => s.kind === 'projectSettings')?.error).toMatch(/Couldn't read it/)
  })

  it.skipIf(process.platform === 'win32')('keeps a symlinked settings file a symlink', async () => {
    const cwd = tempDir()
    const config = tempDir()
    const real = path.join(tempDir(), 'dotfiles-settings.json')
    fs.writeFileSync(real, '{}')
    fs.symlinkSync(real, path.join(config, 'settings.json'))
    await updatePermissionRule(cwd, 'userSettings', 'ask', 'Bash(git push:*)', 'add', { CLAUDE_CONFIG_DIR: config })
    expect(fs.lstatSync(path.join(config, 'settings.json')).isSymbolicLink()).toBe(true)
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ permissions: { ask: ['Bash(git push:*)'] } })
  })
})
