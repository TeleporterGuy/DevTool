import { configDefaults, defineConfig } from 'vitest/config'

// Kept separate from electron.vite.config.ts (which vitest does not read). The default
// environment stays `node`; DOM tests opt in per file with `// @vitest-environment jsdom`.
export default defineConfig({
  test: {
    environment: 'node',
    // relay/ runs its own vitest with its own dependencies; protocol/ts/** is picked up here.
    exclude: [...configDefaults.exclude, '.claude/**', 'out/**', 'dist/**', 'relay/**', 'ios/**']
  }
})
