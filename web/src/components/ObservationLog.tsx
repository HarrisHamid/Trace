import { motion } from 'framer-motion'
import { ChevronDown, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { StatusGlyph } from '@/components/Glyphs'
import { bayer, type GraphNode, type RunView, type Star, type TraceLine } from '@/lib/run'
import type { Scene } from '@/lib/scene'
import { cn } from '@/lib/utils'
import { useTraceStore } from '@/store'
import type { Claim } from '@/types/contracts/events.schema'

export const LOG_WIDTH = 420

const STATUS_TEXT: Record<Claim['status'], string> = {
  verified: 'text-verified',
  unverified: 'text-unverified',
  gap: 'text-gap',
}

function ClaimRow({ claim, sourceNodeId }: { claim: Claim; sourceNodeId: string }) {
  const [expanded, setExpanded] = useState(false)
  const openNode = useTraceStore((state) => state.openNode)

  return (
    <li>
      <div className="flex items-start gap-2">
        <button
          onClick={() => openNode(sourceNodeId, claim.quote ?? null)}
          className="flex min-w-0 flex-1 items-start gap-2 text-left text-xs leading-relaxed text-foreground/85 transition-colors hover:text-foreground"
        >
          <span className="mt-0.5">
            <StatusGlyph status={claim.status} />
          </span>
          <span>
            <span className={cn('mr-1.5 font-medium', STATUS_TEXT[claim.status])}>{claim.status}</span>
            {claim.text}
          </span>
        </button>
        {claim.quote && (
          <button
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide quote' : 'Show quote'}
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
          </button>
        )}
      </div>
      {expanded && (
        <blockquote className="mt-1.5 ml-5.5 overflow-x-auto border-l border-border pl-2 text-[11px] whitespace-pre text-muted-foreground">
          {claim.quote}
        </blockquote>
      )}
    </li>
  )
}

interface StepEntryProps {
  star: Star
  colour: string
  index: number
  name: string
  type: string
  isLast: boolean
  dashedBelow: boolean
  previousNodeId: string | null
}

function StepEntry({ star, colour, index, name, type, isLast, dashedBelow, previousNodeId }: StepEntryProps) {
  const focusNode = useTraceStore((state) => state.focusNode)
  const lit = star.claims !== null

  return (
    <motion.li
      layout="position"
      data-step={star.nodeId}
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className="relative pb-6 pl-8"
    >
      {!isLast && (
        <span
          className={cn(
            'absolute top-6 bottom-0 left-[9px] border-l',
            dashedBelow ? 'border-dashed border-gap' : 'border-primary/50',
          )}
        />
      )}
      <span
        className={cn(
          'absolute top-0 left-0 grid size-5 place-items-center rounded-full border text-[11px]',
          star.status === 'gap' && 'border-dashed border-gap text-gap',
          star.status === 'unverified' && 'border-unverified text-unverified',
          (star.status === 'verified' || star.status === 'visited') && 'border-primary text-primary',
          star.status === 'verified' && 'bg-primary text-primary-foreground',
        )}
      >
        {bayer(index)}
      </span>
      <button onClick={() => focusNode(star.nodeId)} className="group block w-full text-left">
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-xs text-foreground group-hover:text-primary">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: colour }} />
            <span className="truncate">{name}</span>
          </span>
          <span className="kicker shrink-0">{type}</span>
        </span>
        <span className="mt-1 block font-serif text-lg leading-snug text-foreground/90">{star.text}</span>
      </button>
      {lit && (
        <ul className="mt-2 space-y-1.5">
          {star.claims?.map((claim) => (
            <ClaimRow
              key={claim.text}
              claim={claim}
              // A gap is about the link into this step, so its quote is at the call site in the step before.
              sourceNodeId={claim.status === 'gap' && previousNodeId ? previousNodeId : star.nodeId}
            />
          ))}
        </ul>
      )}
    </motion.li>
  )
}

function Trace({ traces, running }: { traces: TraceLine[]; running: boolean }) {
  const [expanded, setExpanded] = useState(false)
  if (traces.length === 0) return null
  const visible = running ? traces.slice(-1) : traces

  return (
    <div className="mt-3 border-t border-border pt-2">
      {!running && (
        <button
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center justify-between text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {traces.length} tool {traces.length === 1 ? 'call' : 'calls'}
          <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
        </button>
      )}
      {(running || expanded) && (
        <ol data-testid="events" className="space-y-0.5 text-[10px] leading-relaxed text-muted-foreground">
          {visible.map((trace) => (
            <li key={trace.index} className="truncate">
              {trace.name}: {trace.args}
              {trace.summary && ` … ${trace.summary}`}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Tally({ tally }: { tally: NonNullable<RunView['tally']> }) {
  return (
    <p className="mt-2 flex gap-3 text-[11px]">
      {(['verified', 'unverified', 'gap'] as const).map((status) => (
        <span key={status} className="flex items-center gap-1.5">
          <StatusGlyph status={status} />
          <span className={STATUS_TEXT[status]}>
            {tally[status]} {status}
          </span>
        </span>
      ))}
    </p>
  )
}

// Stays up from the question until the answer starts to draw, which covers the long wait for the final model call.
function RunStatus({ phase }: { phase: RunView['phase'] }) {
  if (phase === 'walking') {
    return (
      <p role="status" className="flex items-center gap-2 font-serif text-xl leading-none text-primary italic">
        <LoaderCircle aria-hidden className="size-5 animate-spin motion-reduce:animate-none" />
        Agent is cooking
      </p>
    )
  }
  return (
    <p className="kicker flex items-center gap-2" aria-live="polite">
      {phase === 'revealing' && <span className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />}
      {phase === 'revealing' ? 'Tracing' : 'Observation log'}
    </p>
  )
}

interface ObservationLogProps {
  run: RunView
  scene: Scene
  nodesById: Map<string, GraphNode>
  onExit: () => void
}

export function ObservationLog({ run, scene, nodesById, onExit }: ObservationLogProps) {
  const list = useRef<HTMLOListElement>(null)
  const selectedNode = useTraceStore((state) => state.selectedNode)
  const running = run.phase === 'walking' || run.phase === 'revealing'

  useEffect(() => {
    if (!selectedNode) return
    const entry = list.current?.querySelector(`[data-step="${CSS.escape(selectedNode)}"]`)
    entry?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selectedNode])

  return (
    <motion.aside
      aria-label="Observation log"
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="glass absolute inset-y-5 right-5 flex flex-col"
      style={{ width: LOG_WIDTH }}
    >
      <header className="px-5 pt-4 pb-3">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <RunStatus phase={run.phase} />
          <button
            onClick={onExit}
            className="flex shrink-0 items-center gap-1.5 border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
          >
            <X aria-hidden className="size-3.5" />
            Exit walkthrough
            <kbd className="border border-border px-1 text-[10px]">esc</kbd>
          </button>
        </div>
        <h2 className="mt-1.5 font-serif text-3xl leading-tight">{run.question}</h2>
        {run.tally && <Tally tally={run.tally} />}
        <Trace traces={run.traces} running={running} />
      </header>
      <ol ref={list} className="flex-1 overflow-y-auto border-t border-border px-5 pt-4">
        {run.stars.map((star, index) => {
          const node = nodesById.get(star.nodeId)
          return (
            <StepEntry
              key={`${index}:${star.nodeId}`}
              star={star}
              colour={node ? scene.colourOf(node) : 'var(--muted-foreground)'}
              index={index}
              name={node?.name ?? star.nodeId}
              type={node?.type ?? ''}
              isLast={index === run.stars.length - 1}
              dashedBelow={run.segments[index]?.dashed ?? false}
              previousNodeId={run.stars[index - 1]?.nodeId ?? null}
            />
          )
        })}
      </ol>
      {run.error && (
        <p role="alert" className="border-t border-unverified/40 px-5 py-3 text-xs text-unverified">
          The run stopped: {run.error}
        </p>
      )}
    </motion.aside>
  )
}
