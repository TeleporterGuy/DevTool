/**
 * The Agent SDK is ESM-only and main is built as CommonJS with its dependencies
 * left external, so it has to come in through a real dynamic `import()` — which
 * Rollup keeps as-is for CJS output. Loaded once, on the first chat tab.
 *
 * The SDK always gets `pathToClaudeCodeExecutable`: DevTool drives the user's own
 * installed `claude`, so its login (and subscription), settings, hooks and MCP
 * servers are the ones the terminal tab uses. The SDK's bundled binary is never
 * run and is left out of the packaged app.
 */
export type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')

let loading: Promise<ClaudeSdk> | null = null

export function loadClaudeSdk(): Promise<ClaudeSdk> {
  if (!loading) {
    loading = import('@anthropic-ai/claude-agent-sdk').catch((err) => {
      loading = null
      throw err
    })
  }
  return loading
}
