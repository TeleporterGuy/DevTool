import { describe, expect, it } from 'vitest'
import { BLANK_BROWSER_URL, normalizeBrowserUrl } from '../src/renderer/browserUrl'

describe('normalizeBrowserUrl', () => {
  it('preserves http and https urls', () => {
    expect(normalizeBrowserUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeBrowserUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  it('adds https for bare hosts', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com')
  })

  it('trims whitespace before normalizing', () => {
    expect(normalizeBrowserUrl('  example.com/test  ')).toBe('https://example.com/test')
  })

  it('uses a blank page for empty input instead of a search engine', () => {
    expect(normalizeBrowserUrl('')).toBe(BLANK_BROWSER_URL)
    expect(normalizeBrowserUrl('   ')).toBe(BLANK_BROWSER_URL)
    expect(normalizeBrowserUrl('about:blank')).toBe(BLANK_BROWSER_URL)
  })
})
