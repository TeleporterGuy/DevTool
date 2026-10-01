import React from 'react'
import { X } from 'lucide-react'
import type { ChatColdCache } from '../../../shared/claude-chat'
import { formatCost, formatTokens } from './UsageMeter'

/** "1h 55m", "3d 4h": the coarsest two units. */
export function formatIdle(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
  if (h > 0) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.max(m, 1)}m`
}

export function coldCacheText(cache: ChatColdCache): string {
  const idle = cache.idleSeconds !== undefined ? ` (idle ${formatIdle(cache.idleSeconds)})` : ''
  const cost = cache.estimatedUsd !== undefined ? ` (≈ ${cache.estimatedUsd < 0.01 ? '<$0.01' : formatCost(cache.estimatedUsd)})` : ''
  return `Prompt cache expired${idle}. Your next message re-caches ~${formatTokens(cache.contextTokens)} tokens of context${cost}.`
}

/**
 * Above the composer on a resumed chat whose cache went cold: the first send costs
 * a full cache write, whatever it says. Gone once a message is sent.
 */
export default function ColdCacheNotice({ cache, onDismiss }: { cache: ChatColdCache; onDismiss: () => void }): React.ReactElement {
  return (
    <div
      role="status"
      className="flex items-start gap-2 text-sm text-warn rounded-md border border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_8%,transparent)] px-2 py-1"
    >
      <span className="flex-1 min-w-0">{coldCacheText(cache)}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 mt-0.5 text-text-muted hover:text-text cursor-pointer"
      >
        <X size={12} />
      </button>
    </div>
  )
}
