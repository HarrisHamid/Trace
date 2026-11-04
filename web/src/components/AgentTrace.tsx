import { Ban, CircleCheck, CircleDashed, CircleX, CornerDownRight, LoaderCircle } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'

import { StatusGlyph } from '@/components/Glyphs'
import type { GraphNode } from '@/lib/run'
import { deriveTrace, formatMs, MAX_TOOL_CALLS, type Stage, type StageKey, type StageState, type Tally, type ToolRow } from '@/lib/trace'
import { cn } from '@/lib/utils'
import { useTraceStore } from '@/store'

const STAGES: Record<StageKey, { title: string; what: string }> = {
  investigate: {
    title: 'Investigate',
    what: 'Muse Spark calls read-only tools over the code graph and the source.',
  },
  answer: {
    title: 'Answer',
    what: 'One more call, held to a strict JSON schema with no tools, writes the path.',
  },
  validate: {
    title: 'Validate',
    what: 'Plain code checks every claim: the quote must be in that node’s source, each hop an edge.',
  },
  repair: {
    title: 'Repair',
    what: 'One bounded round: only what the validator flagged goes back to the model, once.',
  },
}

const OUTCOME: Record<'accepted' | 'no_improvement' | 'failed', string> = {
  accepted: 'accepted',
  no_improvement: 'changed nothing, first draft stands',
  failed: 'failed, first draft stands',
}

function StateIcon({ state }: { state: StageState }) {
  const shared = 'size-4 shrink-0'
  if (state === 'running')
    return <LoaderCircle aria-label="running" className={cn(shared, 'animate-spin text-primary motion-reduce:animate-none')} />
  if (state === 'done') return <CircleCheck aria-label="done" className={cn(shared, 'text-verified')} />
  if (state === 'failed') return <CircleX aria-label="failed" className={cn(shared, 'text-destructive')} />
  if (state === 'skipped') return <Ban aria-label="skipped" className={cn(shared, 'text-muted-foreground')} />
  return <CircleDashed aria-label="waiting" className={cn(shared, 'text-muted-foreground/60')} />
}

function TallyLine({ tally }: { tally: Tally }) {
  return (
    <span className="flex flex-wrap items-center gap-3">
      {(['verified', 'unverified', 'gap'] as const).map((status) => (
        <span key={status} className="flex items-center gap-1">
          <StatusGlyph status={status} />
          <span className="tabular-nums">{tally[status]}</span> {status}
        </span>
      ))}
    </span>
  )
}

interface NodeLinkProps {
  id: string
  nodesById: Map<string, GraphNode>
  onFocus: (id: string) => void
}

function NodeLink({ id, nodesById, onFocus }: NodeLinkProps) {
  const node = nodesById.get(id)
  if (!node) return <span className="text-foreground/80">{id}</span>
  return (
    <button onClick={() => onFocus(id)} title={id} className="text-primary underline-offset-2 hover:underline">
      {node.name}
    </button>
  )
}

function ToolCallRow({ tool, nodesById, onFocus }: { tool: ToolRow } & Omit<NodeLinkProps, 'id'>) {
  return (
    <li className="grid grid-cols-[1.5rem_1fr_auto] gap-x-2 py-1.5">
      <span className="pt-px text-right font-mono text-[10px] text-muted-foreground tabular-nums">{tool.index + 1}</span>
      <div className="min-w-0">
        <p className="font-mono text-xs leading-relaxed break-words">
          <span className="font-semibold text-foreground">{tool.name}</span>
          <span className="text-muted-foreground">(</span>
          {tool.args.map(([key, value], index) => (
            <span key={key}>
              {index > 0 && <span className="text-muted-foreground">, </span>}
              <span className="text-muted-foreground">{key}=</span>
              {nodesById.has(value) ? (
                <NodeLink id={value} nodesById={nodesById} onFocus={onFocus} />
              ) : (
                <span className="text-[#a5d6ff]">"{value}"</span>
              )}
            </span>
          ))}
          <span className="text-muted-foreground">)</span>
        </p>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {tool.summary === null ? (
            <span className="flex items-center gap-1">
              <LoaderCircle aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
              waiting for the result
            </span>
          ) : (
            <>
              → {tool.summary}
              {tool.ms !== null && <span className="ml-1.5 font-mono text-[10px]">tool {formatMs(tool.ms)}</span>}
            </>
          )}
        </p>
        {tool.visited.map((id) => (
          <p key={id} className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <CornerDownRight aria-hidden className="size-3" />
            on the map: <NodeLink id={id} nodesById={nodesById} onFocus={onFocus} />
          </p>
        ))}
      </div>
      <span title="Model time before this call" className="pt-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
        {formatMs(tool.modelMs)}
      </span>
    </li>
  )
}

function StageBlock({
  stage,
  index,
  last,
  detail,
  children,
}: {
  stage: Stage
  index: number
  last: boolean
  detail: ReactNode
  children?: ReactNode
}) {
  const { title, what } = STAGES[stage.key]
  return (
    <li className="relative pb-5 pl-7">
      {!last && <span aria-hidden className="absolute top-5 bottom-0 left-[7px] border-l border-border" />}
      <span className="absolute top-0.5 left-0">
        <StateIcon state={stage.state} />
      </span>
      <div className="flex items-baseline gap-2">
        <h3 className={cn('text-[13px] font-semibold', stage.state === 'pending' && 'text-muted-foreground')}>
          <span className="mr-1.5 font-mono text-[11px] font-normal text-muted-foreground">{index + 1}</span>
          {title}
        </h3>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">{formatMs(stage.ms)}</span>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{what}</p>
      {detail && <div className="mt-1.5 text-xs text-foreground/90">{detail}</div>}
      {children}
    </li>
  )
}

interface AgentTraceProps {
  nodesById: Map<string, GraphNode>
  recorded: boolean
  fixed: number | null
}

export function AgentTrace({ nodesById, recorded, fixed }: AgentTraceProps) {
  const events = useTraceStore((state) => state.agentRun.events)
  const cursor = useTraceStore((state) => state.playback.cursor)
  const timing = useTraceStore((state) => state.timing)
  const focusNode = useTraceStore((state) => state.focusNode)
  const view = useMemo(() => deriveTrace(events.slice(0, cursor), timing), [events, cursor, timing])
  const [investigate, answer, validate, repair] = view.stages

  let repairDetail: ReactNode = null
  if (view.repair) {
    const outcome = view.repair.outcome
    repairDetail = (
      <span className="block space-y-1">
        <span className="block">
          {view.repair.sentBack} sent back
          {view.repair.leftAlone > 0 && ` · ${view.repair.leftAlone} left alone, no fix possible`}
        </span>
        {outcome && (
          <span className={cn('block', outcome === 'accepted' ? 'text-verified' : 'text-muted-foreground')}>
            {OUTCOME[outcome]}
            {outcome === 'accepted' && fixed !== null && `: ${fixed} of ${view.repair.sentBack} fixed`}
          </span>
        )}
        {view.repair.finalTally && <TallyLine tally={view.repair.finalTally} />}
      </span>
    )
  } else if (repair.state === 'skipped' && view.firstTally) {
    repairDetail = <span className="text-muted-foreground">Nothing flagged, so nothing to repair.</span>
  }

  return (
    <div className="px-5 pt-4">
      <p className="mb-4 flex items-center justify-between rounded border border-border bg-background px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <span>
          <span className="font-mono text-foreground tabular-nums">{view.tools.length}</span> of {MAX_TOOL_CALLS} tool calls
        </span>
        {recorded ? (
          <span title="Recorded runs replay at a fixed pace, so their real timings are not shown">Recorded: timings not saved</span>
        ) : (
          view.totalMs !== null && (
            <span>
              total <span className="font-mono text-foreground tabular-nums">{formatMs(view.totalMs)}</span>
            </span>
          )
        )}
      </p>
      <ol>
        <StageBlock
          stage={investigate}
          index={0}
          last={false}
          detail={
            view.tools.length === 0 && investigate.state === 'running' ? (
              <span className="text-muted-foreground">Waiting for the first tool call…</span>
            ) : null
          }
        >
          {view.tools.length > 0 && (
            <ol className="mt-1.5 divide-y divide-border/60 rounded border border-border bg-background px-1.5">
              {view.tools.map((tool) => (
                <ToolCallRow key={tool.index} tool={tool} nodesById={nodesById} onFocus={focusNode} />
              ))}
            </ol>
          )}
        </StageBlock>
        <StageBlock
          stage={answer}
          index={1}
          last={false}
          detail={view.firstSteps !== null && <span>First draft: {view.firstSteps} steps</span>}
        />
        <StageBlock stage={validate} index={2} last={false} detail={view.firstTally && <TallyLine tally={view.firstTally} />} />
        <StageBlock stage={repair} index={3} last detail={repairDetail} />
      </ol>
      {view.error && (
        <p role="alert" className="mb-4 rounded border border-destructive/40 px-3 py-2 text-xs text-destructive">
          The run stopped: {view.error}
        </p>
      )}
    </div>
  )
}
