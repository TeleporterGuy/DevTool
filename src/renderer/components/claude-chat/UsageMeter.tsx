import React, { useEffect, useState } from 'react'
import type { ChatLimitWindow, ChatUsage } from '../../../shared/claude-chat'

/**
 * The composer's status strip, after Claude Code's own status line: how full the
 * context is (ring + used/max), what the session would cost at API prices, and
 * how much of the plan's 5-hour window is left. Each part shows once main has
 * read it from the CLI; API-key sessions have no plan windows.
 */

/** Used-context colour bands, in tokens (not percent: a 1M window degrades long before it fills). */
const CONTEXT_WARN = 150_000
const CONTEXT_DANGER = 200_000

export function contextTone(tokens: number): 'success' | 'warn' | 'danger' {
  return tokens > CONTEXT_DANGER ? 'danger' : tokens >= CONTEXT_WARN ? 'warn' : 'success'
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

export function formatCost(usd: number): string {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`
}

/** Time left until `iso`: "42m", "3h 12m", "2d 5h"; "now" once it has passed. */
export function formatResetIn(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** The clock, ticking every 30s so countdowns stay current. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

const TONE_TEXT = { success: 'text-success', warn: 'text-warn', danger: 'text-danger' } as const

function Ring({ fraction, tone }: { fraction: number; tone: keyof typeof TONE_TEXT }): React.ReactElement {
  const r = 5.5
  const circumference = 2 * Math.PI * r
  const filled = Math.min(1, Math.max(0, fraction)) * circumference
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={`shrink-0 -rotate-90 ${TONE_TEXT[tone]}`} aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`} />
    </svg>
  )
}

/** " · resets in 3h 12m", or nothing when the window has no reset time. */
function resetsIn(window: ChatLimitWindow, now: number): string {
  const reset = window.resetsAt ? formatResetIn(window.resetsAt, now) : ''
  return reset === 'now' ? ' · resetting now' : reset ? ` · resets in ${reset}` : ''
}

function windowLine(label: string, window: ChatLimitWindow, now: number): string {
  return `${label}: ${Math.round(window.utilization)}% used, ${Math.max(0, 100 - Math.round(window.utilization))}% free${resetsIn(window, now)}`
}

export default function UsageMeter({ usage }: { usage: ChatUsage }): React.ReactElement | null {
  const { contextTokens, contextMax, costUsd, fiveHour, sevenDay } = usage
  const hasContext = contextTokens !== undefined && contextMax !== undefined && contextMax > 0
  const now = useNow(Boolean(fiveHour?.resetsAt || sevenDay?.resetsAt))
  if (!hasContext && costUsd === undefined && !fiveHour) return null

  const tone = hasContext ? contextTone(contextTokens) : 'success'
  const free = fiveHour ? Math.max(0, 100 - Math.round(fiveHour.utilization)) : 0
  const title = [
    hasContext && `Context: ${contextTokens.toLocaleString()} of ${contextMax.toLocaleString()} tokens (${Math.round((contextTokens / contextMax) * 100)}%)`,
    costUsd !== undefined && `Session cost at API prices: $${costUsd.toFixed(4)} (an estimate)`,
    fiveHour && windowLine('5-hour limit', fiveHour, now),
    sevenDay && windowLine('Weekly limit', sevenDay, now)
  ].filter(Boolean).join('\n')

  return (
    <div className="min-w-0 flex items-center gap-2 px-1 text-xs text-text-subtle tabular-nums whitespace-nowrap overflow-hidden" title={title}>
      {hasContext && (
        <span className="inline-flex items-center gap-1">
          <Ring fraction={contextTokens / contextMax} tone={tone} />
          <span><span className={TONE_TEXT[tone]}>{formatTokens(contextTokens)}</span> / {formatTokens(contextMax)}</span>
        </span>
      )}
      {costUsd !== undefined && <span>{formatCost(costUsd)}</span>}
      {fiveHour && (
        <span className={free < 10 ? 'text-danger' : free < 25 ? 'text-warn' : undefined}>
          5h {free}% free{resetsIn(fiveHour, now)}
        </span>
      )}
    </div>
  )
}
