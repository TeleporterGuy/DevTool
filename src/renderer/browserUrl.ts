/** Empty / new browser tabs. Do not fall back to a search engine. */
export const BLANK_BROWSER_URL = 'about:blank'

export function normalizeBrowserUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed || trimmed === BLANK_BROWSER_URL) return BLANK_BROWSER_URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  return `https://${trimmed}`
}
