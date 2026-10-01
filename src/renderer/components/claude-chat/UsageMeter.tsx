import React, { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { menuCls } from '../ui'
import type { ChatLimitWindow, ChatUsage } from '../../../shared/claude-chat'

/**
 * The composer's status strip, after Claude Code's own status line: how full the
 * context is (ring + used/max), how much of the plan's windows is used (5-hour bar
 * over the weekly one, then the 5-hour countdown), and what the session would cost
 * at API prices. Each part shows once main has read it from the CLI; API-key
 * sessions have no plan windows.
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

/** When `iso` falls, on the clock: "14:30" today, "Thu 09:10" on another day. */
export function formatResetAt(iso: string, now: number = Date.now()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** Plan-window colour bands, in percent used. */
export function limitTone(utilization: number): 'success' | 'warn' | 'danger' {
  return utilization > 90 ? 'danger' : utilization > 75 ? 'warn' : 'success'
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
const TONE_BG = { success: 'bg-success', warn: 'bg-warn', danger: 'bg-danger' } as const

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

/** One thin bar of a plan window, filled by the share used; an empty track when unknown. */
function LimitBar({ window }: { window?: ChatLimitWindow }): React.ReactElement {
  const used = window ? Math.min(100, Math.max(0, window.utilization)) : 0
  return (
    <span className="block h-[3px] rounded-full bg-[color-mix(in_srgb,currentColor_18%,transparent)] overflow-hidden">
      {window && <span className={`block h-full rounded-full ${TONE_BG[limitTone(used)]}`} style={{ width: `${used}%` }} />}
    </span>
  )
}


/** "14:30 · in 4h 16m", or "resetting now"; empty when the window has no reset time. */
function resetText(window: ChatLimitWindow, now: number): string {
  const reset = window.resetsAt ? formatResetIn(window.resetsAt, now) : ''
  if (!reset) return ''
  return reset === 'now' ? 'resetting now' : `${formatResetAt(window.resetsAt as string, now)} · in ${reset}`
}

/** One row of a limits popover: the window's name, then its value. */
function PopoverRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-text">{label}</span>
      {children}
    </div>
  )
}

/** What a hover over the limits shows: the bars give each window's usage, the countdown the resets. */
type LimitsHover = { kind: 'usage' | 'reset'; rect: DOMRect }

export default function UsageMeter({ usage }: { usage: ChatUsage }): React.ReactElement | null {
  const { contextTokens, contextMax, costUsd, fiveHour, sevenDay } = usage
  const hasContext = contextTokens !== undefined && contextMax !== undefined && contextMax > 0
  const now = useNow(Boolean(fiveHour?.resetsAt || sevenDay?.resetsAt))
  // The limits popover, pinned above what is hovered. Drawn by us, not a `title`:
  // native tooltips can stay hidden, and these are the numbers the strip leaves out.
  const [hover, setHover] = useState<LimitsHover | null>(null)
  const hoverProps = (kind: LimitsHover['kind']): React.HTMLAttributes<HTMLSpanElement> => ({
    onMouseEnter: (e) => setHover({ kind, rect: e.currentTarget.getBoundingClientRect() }),
    onMouseLeave: () => setHover(null)
  })
  if (!hasContext && costUsd === undefined && !fiveHour && !sevenDay) return null

  const tone = hasContext ? contextTone(contextTokens) : 'success'
  const resetIn = fiveHour?.resetsAt ? formatResetIn(fiveHour.resetsAt, now) : ''
  return (
    <div className="min-w-0 flex items-center gap-2 px-1 text-xs text-text-subtle tabular-nums whitespace-nowrap overflow-hidden">
      {hasContext && (
        <span
          className="inline-flex items-center gap-1"
          title={`Context: ${contextTokens.toLocaleString()} of ${contextMax.toLocaleString()} tokens (${Math.round((contextTokens / contextMax) * 100)}%)`}
        >
          <Ring fraction={contextTokens / contextMax} tone={tone} />
          <span><span className={TONE_TEXT[tone]}>{formatTokens(contextTokens)}</span> / {formatTokens(contextMax)}</span>
        </span>
      )}
      {(fiveHour || sevenDay) && (
        <span className="inline-flex items-center gap-1.5 cursor-default">
          {/* Padded so the 8px of bars is an easy target. */}
          <span className="inline-flex flex-col justify-center gap-0.5 w-9 py-1" {...hoverProps('usage')}>
            <LimitBar window={fiveHour} />
            <LimitBar window={sevenDay} />
          </span>
          {fiveHour && resetIn && (
            <span {...hoverProps('reset')} className={`inline-flex items-center gap-0.5 ${limitTone(fiveHour.utilization) === 'success' ? '' : TONE_TEXT[limitTone(fiveHour.utilization)]}`}>
              <RotateCcw size={10} strokeWidth={2.25} className="shrink-0" />
              {resetIn}
            </span>
          )}
        </span>
      )}
      {costUsd !== undefined && <span title={`Session cost at API prices: $${costUsd.toFixed(4)} (an estimate)`}>{formatCost(costUsd)}</span>}
      {hover && (
        // Fixed, so the strip's overflow clip doesn't cut it; right-aligned to the target, opening left.
        <div
          role="tooltip"
          className={`fixed z-(--z-menu) pointer-events-none flex flex-col gap-1 px-2.5 py-2 text-xs whitespace-nowrap tabular-nums ${menuCls}`}
          style={{ right: Math.max(8, window.innerWidth - hover.rect.right), bottom: window.innerHeight - hover.rect.top + 8 }}
        >
          {hover.kind === 'usage' ? (
            <>
              {fiveHour && <PopoverRow label="5-hour limit"><span className={TONE_TEXT[limitTone(fiveHour.utilization)]}>{Math.round(fiveHour.utilization)}% used</span></PopoverRow>}
              {sevenDay && <PopoverRow label="Weekly limit"><span className={TONE_TEXT[limitTone(sevenDay.utilization)]}>{Math.round(sevenDay.utilization)}% used</span></PopoverRow>}
            </>
          ) : (
            <>
              <div className="text-text-muted">Resets</div>
              {fiveHour && resetText(fiveHour, now) && <PopoverRow label="5-hour limit"><span className="text-text-muted">{resetText(fiveHour, now)}</span></PopoverRow>}
              {sevenDay && resetText(sevenDay, now) && <PopoverRow label="Weekly limit"><span className="text-text-muted">{resetText(sevenDay, now)}</span></PopoverRow>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
