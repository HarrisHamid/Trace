import type { AgentRun, Playback } from '@/store'
import type { AgentEvent, Claim, PathStep } from '@/types/contracts/events.schema'
import type { Graph } from '@/types/contracts/graph.schema'

export type GraphNode = Graph['nodes'][number]
export type StarStatus = 'visited' | 'verified' | 'unverified' | 'gap'

export const STEP_MS = 400
const CAMERA_SETTLE_MS = 550
const TOOL_HOLD_MS = 120

// Bayer designations: the stars of a constellation are lettered in order, so the map and the log share one label.
const GREEK = 'αβγδεζηθικλμνξοπρστυφχψω'

export function bayer(index: number): string {
  return GREEK[index] ?? String(index + 1)
}

export interface Star {
  nodeId: string
  text: string
  claims: Claim[] | null
  status: StarStatus
}

export interface Segment {
  from: string
  to: string
  dashed: boolean
}

export interface TraceLine {
  index: number
  name: string
  args: string
  summary: string | null
}

export interface RunView {
  phase: 'idle' | 'walking' | 'revealing' | 'settled'
  question: string
  stars: Star[]
  walked: string[]
  segments: Segment[]
  revealed: number
  current: string | null
  caption: string | null
  traces: TraceLine[]
  error: string | null
  tally: Record<Claim['status'], number> | null
}

export function isRevealing(events: AgentEvent[], { cursor, pathStep }: Playback): boolean {
  const last = events[cursor - 1]
  return last?.type === 'final_path' && pathStep < last.steps.length
}

// Milliseconds to hold before showing the next thing, or null when playback has caught up with the stream.
export function nextDelay(events: AgentEvent[], playback: Playback): number | null {
  if (isRevealing(events, playback)) return playback.pathStep === 0 ? CAMERA_SETTLE_MS : STEP_MS
  if (playback.cursor >= events.length) return null
  const last = events[playback.cursor - 1]
  if (last?.type === 'tool_call' || last?.type === 'tool_result') return TOOL_HOLD_MS
  return last ? STEP_MS : 0
}

function statusOf(claims: Claim[]): StarStatus {
  if (claims.some((claim) => claim.status === 'gap')) return 'gap'
  if (claims.some((claim) => claim.status === 'unverified')) return 'unverified'
  return 'verified'
}

function toSegments(graph: Graph, steps: PathStep[]): Segment[] {
  const firm = new Set(
    graph.edges
      .filter((edge) => edge.type !== 'uncertain')
      .flatMap((edge) => [`${edge.source}>${edge.target}`, `${edge.target}>${edge.source}`]),
  )
  return steps.slice(1).map((step, index) => {
    const from = steps[index].node_id
    const dashed = !firm.has(`${from}>${step.node_id}`) || step.claims.some((claim) => claim.status === 'gap')
    return { from, to: step.node_id, dashed }
  })
}

function toTraces(events: AgentEvent[]): TraceLine[] {
  const traces = new Map<number, TraceLine>()
  for (const event of events) {
    if (event.type === 'tool_call') {
      const args = Object.values(event.args).map(String).join(', ')
      traces.set(event.call_index, { index: event.call_index, name: event.name, args, summary: null })
    } else if (event.type === 'tool_result') {
      const trace = traces.get(event.call_index)
      if (trace) trace.summary = event.summary
    }
  }
  return [...traces.values()]
}

function toTally(steps: PathStep[]): RunView['tally'] {
  const tally = { verified: 0, unverified: 0, gap: 0 }
  for (const claim of steps.flatMap((step) => step.claims)) tally[claim.status] += 1
  return tally
}

export function deriveRun(graph: Graph, run: AgentRun, playback: Playback): RunView {
  const events = run.events.slice(0, playback.cursor)
  const visits = events.filter((event) => event.type === 'node_visited')
  const steps = events.find((event) => event.type === 'final_path')?.steps ?? []
  const error = events.findLast((event) => event.type === 'error')?.message ?? null
  const revealed = Math.min(playback.pathStep, steps.length)

  const shown: Star[] = steps.slice(0, revealed).map((step) => ({
    nodeId: step.node_id,
    text: step.explanation,
    claims: step.claims,
    status: statusOf(step.claims),
  }))
  // Stars from the walk stay up until the whole path has replaced them.
  const walking: Star[] = visits
    .filter((visit) => !shown.some((star) => star.nodeId === visit.node_id))
    .map((visit) => ({ nodeId: visit.node_id, text: visit.reason, claims: null, status: 'visited' }))
  const stars = [...shown, ...walking]

  const caughtUp = playback.cursor >= run.events.length && revealed === steps.length
  const settled = run.status !== 'running' && caughtUp
  const reveal = steps.length > 0 && !settled
  let phase: RunView['phase'] = 'walking'
  if (run.status === 'idle') phase = 'idle'
  else if (settled) phase = 'settled'
  else if (reveal) phase = 'revealing'

  const latestStep = reveal ? steps[revealed - 1] : undefined
  const latestVisit = phase === 'walking' ? visits.at(-1) : undefined

  return {
    phase,
    question: run.question,
    stars,
    walked: visits.map((visit) => visit.node_id),
    segments: toSegments(graph, steps),
    revealed,
    current: latestStep?.node_id ?? latestVisit?.node_id ?? null,
    caption: latestStep?.explanation ?? latestVisit?.reason ?? null,
    traces: toTraces(events),
    error,
    tally: steps.length > 0 && revealed === steps.length ? toTally(steps) : null,
  }
}
