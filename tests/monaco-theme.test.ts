import { describe, expect, it } from 'vitest'
import {
  MONACO_TOKEN_RULES_DARK,
  MONACO_TOKEN_RULES_LIGHT
} from '../src/renderer/components/monacoTheme'

function foregroundFor(rules: { token: string; foreground?: string }[], token: string): string | undefined {
  return rules.find((rule) => rule.token === token)?.foreground
}

describe('Monaco token rules vs idle hljs palette', () => {
  it('colors dark parameters and identifiers like .hljs-params (#9cdcfe)', () => {
    expect(foregroundFor(MONACO_TOKEN_RULES_DARK, 'parameter')).toBe('9cdcfe')
    expect(foregroundFor(MONACO_TOKEN_RULES_DARK, 'variable.parameter')).toBe('9cdcfe')
    expect(foregroundFor(MONACO_TOKEN_RULES_DARK, 'variable')).toBe('9cdcfe')
    expect(foregroundFor(MONACO_TOKEN_RULES_DARK, 'identifier')).toBe('9cdcfe')
    expect(foregroundFor(MONACO_TOKEN_RULES_DARK, 'keyword')).toBe('c586c0')
    expect(foregroundFor(MONACO_TOKEN_RULES_DARK, 'string')).toBe('ce9178')
    expect(foregroundFor(MONACO_TOKEN_RULES_DARK, 'comment')).toBe('6a9955')
    expect(foregroundFor(MONACO_TOKEN_RULES_DARK, 'number')).toBe('b5cea8')
    expect(foregroundFor(MONACO_TOKEN_RULES_DARK, 'function')).toBe('dcdcaa')
  })

  it('colors light parameters like .hljs-params (#001080)', () => {
    expect(foregroundFor(MONACO_TOKEN_RULES_LIGHT, 'parameter')).toBe('001080')
    expect(foregroundFor(MONACO_TOKEN_RULES_LIGHT, 'identifier')).toBe('001080')
    expect(foregroundFor(MONACO_TOKEN_RULES_LIGHT, 'keyword')).toBe('af00db')
    expect(foregroundFor(MONACO_TOKEN_RULES_LIGHT, 'comment')).toBe('008000')
  })
})
