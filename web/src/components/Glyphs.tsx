import type { GraphNode } from '@/lib/run'
import type { Claim } from '@/types/contracts/events.schema'

// Claim status is never colour alone: filled, hollow and broken read differently without it.
export function StatusGlyph({ status }: { status: Claim['status'] }) {
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 shrink-0" style={{ color: `var(--status-${status})` }} aria-hidden>
      {status === 'verified' && (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4 7.2 6.2 9.4 10 5" fill="none" stroke="var(--background)" strokeWidth="1.6" />
        </>
      )}
      {status === 'unverified' && <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {status === 'gap' && (
        <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.9" />
      )}
    </svg>
  )
}

const STAR = 'M7 .8 8.9 4.8 13.2 5.4 10.1 8.4 10.8 12.7 7 10.7 3.2 12.7 3.9 8.4.8 5.4 5.1 4.8Z'
const HEXAGON = 'M7 1 12.2 4V10L7 13 1.8 10V4Z'
const DIAMOND = 'M7 1 13 7 7 13 1 7Z'

export function NodeGlyph({ type }: { type: GraphNode['type'] }) {
  const colour = `var(--star-${type})`
  return (
    <svg viewBox="0 0 14 14" className="size-3 shrink-0" aria-hidden>
      {type === 'route' && <path d={STAR} fill={colour} />}
      {type === 'class' && <path d={HEXAGON} fill={colour} />}
      {type === 'dependency' && <path d={DIAMOND} fill={colour} />}
      {type === 'function' && <circle cx="7" cy="7" r="4" fill={colour} />}
      {type === 'external' && <circle cx="7" cy="7" r="4" fill="none" stroke={colour} strokeWidth="1.5" />}
      {type === 'module' && (
        <circle cx="7" cy="7" r="5.5" fill="none" stroke={colour} strokeWidth="1" strokeDasharray="1 2" />
      )}
    </svg>
  )
}
