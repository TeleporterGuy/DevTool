import { describe, expect, it } from 'vitest'
import { parseGitPostureStatus, parseLastCommit } from '../src/main/ipc/git'
import { claudeProjectSlug, isClaudeSessionId } from '../src/main/ipc/agents'
import { parseExternalUrl } from '../src/main/ipc/window'
import { trimScrollback, MAX_SCROLLBACK_CHARS } from '../src/main/pty-sessions'

describe('parseGitPostureStatus', () => {
  it('reads branch, upstream, ahead/behind and dirty entries', () => {
    const stdout = [
      '# branch.oid 0123',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 a b src/a.ts',
      '? untracked.txt',
      ''
    ].join('\n')
    expect(parseGitPostureStatus(stdout)).toEqual({
      branch: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 3, dirtyCount: 2
    })
  })

  it('defaults when there is no upstream', () => {
    expect(parseGitPostureStatus('# branch.head main\n')).toEqual({
      branch: 'main', upstream: null, ahead: 0, behind: 0, dirtyCount: 0
    })
  })
})

describe('parseLastCommit', () => {
  it('splits the NUL-separated log line', () => {
    expect(parseLastCommit('abc\x00Fix it\x00Ann\x002026-01-01T00:00:00Z\n')).toEqual({
      sha: 'abc', subject: 'Fix it', author: 'Ann', isoDate: '2026-01-01T00:00:00Z'
    })
  })

  it('is null for an empty repo', () => {
    expect(parseLastCommit('\n')).toBeNull()
  })
})

describe('agent helpers', () => {
  it('derives Claude project slugs', () => {
    expect(claudeProjectSlug('/Users/me/my.app')).toBe('-Users-me-my-app')
  })

  it('only accepts uuid-like session ids', () => {
    expect(isClaudeSessionId('3f2a9c1e-0000-4000-8000-000000000000')).toBe(true)
    expect(isClaudeSessionId('x; rm -rf ~')).toBe(false)
    expect(isClaudeSessionId('../../etc')).toBe(false)
  })
})

describe('parseExternalUrl', () => {
  it('allows only http and https', () => {
    expect(parseExternalUrl('https://example.com/a').toString()).toBe('https://example.com/a')
    expect(() => parseExternalUrl('file:///etc/passwd')).toThrow(/Only http/)
    expect(() => parseExternalUrl('nope')).toThrow(/Invalid URL/)
  })
})

describe('trimScrollback', () => {
  it('keeps the tail when over the limit', () => {
    const long = 'a'.repeat(MAX_SCROLLBACK_CHARS) + 'tail'
    const trimmed = trimScrollback(long)
    expect(trimmed.length).toBe(MAX_SCROLLBACK_CHARS)
    expect(trimmed.endsWith('tail')).toBe(true)
  })
})
