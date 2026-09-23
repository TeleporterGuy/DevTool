/**
 * Tabs that just turned from one Claude view into the other. The user asked for
 * the switch, so the new view resumes the session straight away instead of
 * waiting behind the lazy-load "Click to resume" gate.
 */
const handoffs = new Set<string>()

export function markClaudeHandoff(tabId: string): void {
  handoffs.add(tabId)
}

/** True once for a tab that was just converted; clears the mark. */
export function takeClaudeHandoff(tabId: string): boolean {
  return handoffs.delete(tabId)
}
