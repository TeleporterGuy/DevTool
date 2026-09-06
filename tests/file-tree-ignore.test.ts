import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILE_TREE_IGNORE,
  effectiveIgnorePatterns,
  formatIgnoreText,
  nameMatchesIgnore,
  parseIgnoreText
} from '../src/shared/file-tree-ignore'

describe('file-tree-ignore', () => {
  it('uses defaults when ignore is missing and not showing ignored', () => {
    expect(effectiveIgnorePatterns(undefined, false)).toEqual([...DEFAULT_FILE_TREE_IGNORE])
  })

  it('shows everything when includeIgnored is true', () => {
    expect(effectiveIgnorePatterns(['node_modules'], true)).toEqual([])
  })

  it('keeps an empty saved list (user cleared the defaults)', () => {
    expect(effectiveIgnorePatterns([], false)).toEqual([])
  })

  it('matches basename globs, including .* for dotfiles', () => {
    expect(nameMatchesIgnore('.env', ['.*'], false)).toBe(true)
    expect(nameMatchesIgnore('hello.py', ['.*'], false)).toBe(false)
    expect(nameMatchesIgnore('node_modules', ['node_modules'], false)).toBe(true)
    expect(nameMatchesIgnore('__pycache__', DEFAULT_FILE_TREE_IGNORE, false)).toBe(true)
    expect(nameMatchesIgnore('foo.pyc', ['*.pyc'], false)).toBe(true)
    expect(nameMatchesIgnore('foo.py', ['*.pyc'], false)).toBe(false)
  })

  it('is case-insensitive when asked (Windows)', () => {
    expect(nameMatchesIgnore('Node_Modules', ['node_modules'], true)).toBe(true)
    expect(nameMatchesIgnore('Node_Modules', ['node_modules'], false)).toBe(false)
  })

  it('skips comments and blank lines', () => {
    expect(nameMatchesIgnore('dist', ['# keep this', '', 'dist'], false)).toBe(true)
    expect(parseIgnoreText('# comment\n\nnode_modules\n')).toEqual(['# comment', 'node_modules'])
    expect(formatIgnoreText(['a', 'b'])).toBe('a\nb')
  })
})
