import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import { loadClaudeSdk } from './sdk'

/**
 * A chat's history is Claude's own transcript (`~/.claude/projects/<dir>/<id>.jsonl`),
 * so a session reads the same whether its turns ran in the chat or in a terminal
 * tab. The SDK's reader rebuilds the conversation chain (rewinds, compaction,
 * sidechains) exactly as `--resume` does; for a remote project the raw JSONL is
 * fetched over ssh and handed to the same reader through a read-only store.
 */

export const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/

/** Parse raw JSONL, skipping a torn trailing line (the file is appended to live). */
export function parseTranscriptLines(raw: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) entries.push(value as Record<string, unknown>)
    } catch {
      // Partial line mid-write, or not ours — skip.
    }
  }
  return entries
}

function readOnlyStore(entries: Record<string, unknown>[]): SessionStore {
  return {
    append: async () => {},
    load: async () => (entries.length > 0 ? entries as never : null)
  }
}

/** Local transcript messages, oldest first; empty when the session was never saved. */
export async function readLocalTranscript(sessionId: string, cwd: string): Promise<unknown[]> {
  if (!SESSION_ID_RE.test(sessionId)) return []
  const sdk = await loadClaudeSdk()
  const inDir = await sdk.getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true }).catch(() => [])
  if (inDir.length > 0) return inDir
  // The slug Claude derives from cwd can differ (symlinks, a worktree moved); search everywhere.
  return sdk.getSessionMessages(sessionId, { includeSystemMessages: true }).catch(() => [])
}

/** The shell script that prints a remote session's newest transcript file. */
export function remoteTranscriptScript(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid session id')
  const configDir = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'
  return `f=$(ls -t ${configDir}/projects/*/${sessionId}.jsonl 2>/dev/null | head -1); [ -n "$f" ] && cat "$f" || true`
}

export async function readRemoteTranscript(sessionId: string, fetchRaw: (script: string) => Promise<string>): Promise<unknown[]> {
  if (!SESSION_ID_RE.test(sessionId)) return []
  const raw = await fetchRaw(remoteTranscriptScript(sessionId))
  const entries = parseTranscriptLines(raw)
  if (entries.length === 0) return []
  const sdk = await loadClaudeSdk()
  return sdk.getSessionMessages(sessionId, { sessionStore: readOnlyStore(entries), includeSystemMessages: true }).catch(() => [])
}
