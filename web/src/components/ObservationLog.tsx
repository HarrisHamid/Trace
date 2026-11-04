import { motion } from 'framer-motion'
import { ChevronDown, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { StatusGlyph } from '@/components/Glyphs'
import { isRecorded } from '@/lib/examples'
import { stepLabel, type GraphNode, type RepairView, type RunView, type Star, type Tally as TallyCounts, type TraceLine } from '@/lib/run'
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

function ClaimRow({ claim, sourceNodeId, fixed }: { claim: Claim; sourceNodeId: string; fixed: boolean }) {
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
            {fixed && <span className="mr-1.5 text-primary">fixed in repair</span>}
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
  fixedClaims: Set<string> | null
}

function StepEntry({ star, colour, index, name, type, isLast, dashedBelow, previousNodeId, fixedClaims }: StepEntryProps) {
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
          'absolute top-0 left-0 grid size-5 place-items-center rounded-full border font-mono text-[10px] font-semibold',
          star.status === 'gap' && 'border-dashed border-gap text-gap',
          star.status === 'unverified' && 'border-unverified text-unverified',
          star.status === 'visited' && 'border-primary text-primary',
          star.status === 'verified' && 'border-verified bg-verified text-background',
        )}
      >
        {stepLabel(index)}
      </span>
      <button onClick={() => focusNode(star.nodeId)} className="group block w-full text-left">
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-xs text-foreground group-hover:text-primary">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: colour }} />
            <span className="truncate font-mono">{name}</span>
          </span>
          <span className="kicker shrink-0">{star.added ? `added in repair · ${type}` : type}</span>
        </span>
        <span className="mt-1 block text-[13px] leading-relaxed text-foreground/90">{star.text}</span>
      </button>
      {lit && (
        <ul className="mt-2 space-y-1.5">
          {star.claims?.map((claim) => (
            <ClaimRow
              key={claim.text}
              claim={claim}
              // A moved claim still shows at its old step until the redraw gets there, and that copy is not fixed.
              fixed={claim.status === 'verified' && (fixedClaims?.has(claim.text) ?? false)}
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
            <li key={trace.index} className="truncate font-mono">
              {trace.name}: {trace.args}
              {trace.summary && ` … ${trace.summary}`}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Tally({ tally }: { tally: TallyCounts }) {
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

const REPAIR_HEADLINE: Record<RepairView['stage'], string> = {
  repairing: 'The validator sent this back',
  accepted: 'Repaired',
  no_improvement: 'Repair changed nothing, so the first draft stands',
  failed: 'Repair failed, so the first draft stands',
}

// The first draft's tally stays on screen for good: a repair must never hide what it replaced.
function RepairPanel({ repair, onFocus }: { repair: RepairView; onFocus: (nodeId: string) => void }) {
  const [opened, setOpened] = useState(false)
  const repairing = repair.stage === 'repairing'
  const expanded = repairing || opened
  const fixed = repair.lines.filter((line) => line.fixed).length

  return (
    <section aria-label="Repair" className="mt-3 border-t border-border pt-2">
      <p role="status" className="flex items-center gap-2 text-[11px] text-foreground">
        {repairing && <LoaderCircle aria-hidden className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />}
        {REPAIR_HEADLINE[repair.stage]}
      </p>
      <p className="kicker mt-2">First draft</p>
      <Tally tally={repair.firstTally} />
      {repair.finalTally && (
        <>
          <p className="kicker mt-2">After repair</p>
          <Tally tally={repair.finalTally} />
        </>
      )}
      <button
        aria-expanded={expanded}
        disabled={repairing}
        onClick={() => setOpened(!opened)}
        className="mt-2 flex w-full items-center justify-between text-[10px] text-muted-foreground transition-colors enabled:hover:text-foreground"
      >
        {repairing ? `${repair.lines.length} sent back` : `${fixed} of ${repair.lines.length} sent back were fixed`}
        {repair.leftAlone > 0 && ` · ${repair.leftAlone} cannot be fixed`}
        {!repairing && <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />}
      </button>
      {expanded && (
        <ul className="mt-1 max-h-36 space-y-1 overflow-y-auto">
          {repair.lines.map((line) => (
            <li key={`${line.nodeId}:${line.text}`}>
              <button
                onClick={() => onFocus(line.nodeId)}
                className="flex w-full items-start gap-1.5 text-left text-[11px] leading-snug text-foreground/85 transition-colors hover:text-foreground"
              >
                <span className="mt-0.5">
                  <StatusGlyph status={line.fixed ? 'verified' : line.kind === 'gap' ? 'gap' : 'unverified'} />
                </span>
                <span>{line.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Stays up from the question until the answer starts to draw, which covers the long wait for the final model call.
function RunStatus({ phase, recorded }: { phase: RunView['phase']; recorded: boolean }) {
  if (phase === 'walking') {
    return (
      <p role="status" className="flex items-center gap-2 text-[13px] font-medium text-primary">
        <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
        {recorded ? 'Replaying a recorded run' : 'Agent is investigating'}
      </p>
    )
  }
  return (
    <p className="kicker flex items-center gap-2" aria-live="polite">
      {phase === 'revealing' && <span className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />}
      {phase === 'revealing' ? 'Drawing the answer' : recorded ? 'Recorded run' : 'Live run'}
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
  const focusNode = useTraceStore((state) => state.focusNode)
  const running = run.phase === 'walking' || run.phase === 'revealing'

  useEffect(() => {
    if (!selectedNode) return
    const entry = list.current?.querySelector(`[data-step="${CSS.escape(selectedNode)}"]`)
    entry?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selectedNode])

  return (
    <motion.aside
      aria-label="Answer"
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="glass absolute inset-y-5 right-5 flex flex-col"
      style={{ width: LOG_WIDTH }}
    >
      <header className="px-5 pt-4 pb-3">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <RunStatus phase={run.phase} recorded={isRecorded(run.question)} />
          <button
            onClick={onExit}
            className="flex shrink-0 items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
          >
            <X aria-hidden className="size-3.5" />
            Close
            <kbd className="border border-border px-1 text-[10px]">esc</kbd>
          </button>
        </div>
        <h2 className="mt-1.5 text-lg leading-snug font-semibold">{run.question}</h2>
        {run.repair ? <RepairPanel repair={run.repair} onFocus={focusNode} /> : run.tally && <Tally tally={run.tally} />}
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
              fixedClaims={run.repair?.fixedClaims ?? null}
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
