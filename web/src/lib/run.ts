import type { AgentRun, Playback } from '@/store'
import type { AgentEvent, Claim, PathStep } from '@/types/contracts/events.schema'
import type { Graph } from '@/types/contracts/graph.schema'

export type GraphNode = Graph['nodes'][number]
export type StarStatus = 'visited' | 'verified' | 'unverified' | 'gap'

export const STEP_MS = 400
const CAMERA_SETTLE_MS = 550
const TOOL_HOLD_MS = 120
// Long enough to read what was sent back, because a replay has no model call to wait for.
const REPAIR_HOLD_MS = 2500

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
  added: boolean
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

export type Tally = Record<Claim['status'], number>

export interface RepairLine {
  kind: 'claim' | 'gap'
  nodeId: string
  text: string
  fixed: boolean
}

// Present once anything was sent back. The first draft's tally stays here so the repair never hides what it replaced.
export interface RepairView {
  stage: 'repairing' | 'accepted' | 'no_improvement' | 'failed'
  lines: RepairLine[]
  leftAlone: number
  firstTally: Tally
  finalTally: Tally | null
  fixedClaims: Set<string>
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
  tally: Tally | null
  repair: RepairView | null
}

function acceptedRepair(events: AgentEvent[]): PathStep[] | null {
  const finished = events.find((event) => event.type === 'repair_finished')
  return finished?.outcome === 'accepted' ? finished.steps : null
}

function firstPath(events: AgentEvent[]): PathStep[] {
  return events.find((event) => event.type === 'final_path')?.steps ?? []
}

// Everything before this step is unchanged, so a repair only redraws from here.
function firstChange(first: PathStep[], repaired: PathStep[]): number {
  const index = repaired.findIndex((step, position) => JSON.stringify(step) !== JSON.stringify(first[position]))
  return index === -1 ? repaired.length : index
}

// pathStep keeps counting past the first reveal, so one counter drives both reveals.
export function isRevealing(events: AgentEvent[], { cursor, pathStep }: Playback): boolean {
  const last = events[cursor - 1]
  if (last?.type === 'final_path') return pathStep < last.steps.length
  if (last?.type !== 'repair_finished') return false
  const repaired = acceptedRepair(events)
  if (!repaired) return false
  const first = firstPath(events)
  return pathStep < first.length + repaired.length - firstChange(first, repaired)
}

// Milliseconds to hold before showing the next thing, or null when playback has caught up with the stream.
export function nextDelay(events: AgentEvent[], playback: Playback): number | null {
  if (isRevealing(events, playback)) return playback.pathStep === 0 ? CAMERA_SETTLE_MS : STEP_MS
  if (playback.cursor >= events.length) return null
  const last = events[playback.cursor - 1]
  if (last?.type === 'tool_call' || last?.type === 'tool_result') return TOOL_HOLD_MS
  if (last?.type === 'repair_started') return REPAIR_HOLD_MS
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
      .filter((edge) => edge.resolved)
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

function toTally(steps: PathStep[]): Tally {
  const tally = { verified: 0, unverified: 0, gap: 0 }
  for (const claim of steps.flatMap((step) => step.claims)) tally[claim.status] += 1
  return tally
}

function toStar(step: PathStep, added = false): Star {
  return { nodeId: step.node_id, text: step.explanation, claims: step.claims, status: statusOf(step.claims), added }
}

// A repair only inserts steps, so walking both paths together finds the new ones.
function insertedSteps(first: PathStep[], repaired: PathStep[]): Set<number> {
  const inserted = new Set<number>()
  let position = 0
  repaired.forEach((step, index) => {
    if (first[position]?.node_id === step.node_id) position += 1
    else inserted.add(index)
  })
  return inserted
}

// Sentences cannot change in a repair, so a sentence that is now verified is one the repair fixed.
function fixedSentences(first: PathStep[], repaired: PathStep[]): Set<string> {
  const before = new Set(first.flatMap((step) => step.claims).filter((claim) => claim.status !== 'verified').map((claim) => claim.text))
  const after = repaired.flatMap((step) => step.claims).filter((claim) => claim.status === 'verified')
  return new Set(after.map((claim) => claim.text).filter((text) => before.has(text)))
}

function toRepair(events: AgentEvent[], first: PathStep[], fullyDrawn: boolean): RepairView | null {
  const started = events.find((event) => event.type === 'repair_started')
  if (!started) return null
  const finished = events.find((event) => event.type === 'repair_finished')
  const repaired = acceptedRepair(events)
  const fixedClaims = repaired ? fixedSentences(first, repaired) : new Set<string>()
  const gaps = new Set((repaired ?? []).flatMap((step) => step.claims).filter((claim) => claim.status === 'gap').map((claim) => claim.text))
  return {
    stage: finished?.outcome ?? 'repairing',
    lines: started.issues.map((issue) => ({
      kind: issue.kind,
      nodeId: issue.node_id,
      text: issue.text,
      fixed: repaired !== null && (issue.kind === 'gap' ? !gaps.has(issue.text) : fixedClaims.has(issue.text)),
    })),
    leftAlone: started.left_alone,
    firstTally: toTally(first),
    finalTally: repaired && fullyDrawn ? toTally(repaired) : null,
    fixedClaims,
  }
}

export function deriveRun(graph: Graph, run: AgentRun, playback: Playback): RunView {
  const events = run.events.slice(0, playback.cursor)
  const visits = events.filter((event) => event.type === 'node_visited')
  const first = firstPath(events)
  const repaired = acceptedRepair(events)
  const steps = repaired ?? first
  const error = events.findLast((event) => event.type === 'error')?.message ?? null
  const revealFrom = repaired ? firstChange(first, repaired) : 0
  const revealOffset = repaired ? revealFrom - first.length : 0
  const revealed = Math.min(playback.pathStep + revealOffset, steps.length)

  const inserted = repaired ? insertedSteps(first, repaired) : new Set<number>()
  const shown = steps.slice(0, revealed).map((step, index) => toStar(step, inserted.has(index)))
  // While a repair draws, the steps it has not reached keep their first-draft state, so the log does not collapse.
  const addedSoFar = [...inserted].filter((index) => index < revealed).length
  const waiting = repaired ? first.slice(revealed - addedSoFar).map((step) => toStar(step)) : []
  const answer = [...shown, ...waiting]
  // Stars from the walk stay up until the whole path has replaced them.
  const walking: Star[] = visits
    .filter((visit) => !answer.some((star) => star.nodeId === visit.node_id))
    .map((visit) => ({ nodeId: visit.node_id, text: visit.reason, claims: null, status: 'visited', added: false }))
  const stars = [...answer, ...walking]

  const caughtUp = playback.cursor >= run.events.length && revealed === steps.length
  const settled = run.status !== 'running' && caughtUp
  const reveal = steps.length > 0 && !settled
  let phase: RunView['phase'] = 'walking'
  if (run.status === 'idle') phase = 'idle'
  else if (settled) phase = 'settled'
  else if (reveal) phase = 'revealing'

  const repair = toRepair(events, first, revealed === steps.length)
  const sentBack = repair?.stage === 'repairing' ? repair.lines[0] : undefined
  const latestStep = reveal && !sentBack ? steps[revealed - 1] : undefined
  const latestVisit = phase === 'walking' ? visits.at(-1) : undefined

  return {
    phase,
    question: run.question,
    stars,
    walked: visits.map((visit) => visit.node_id),
    segments: toSegments(graph, steps),
    revealed,
    current: sentBack?.nodeId ?? latestStep?.node_id ?? latestVisit?.node_id ?? null,
    caption: sentBack ? `Sent back: ${sentBack.text}` : (latestStep?.explanation ?? latestVisit?.reason ?? null),
    traces: toTraces(events),
    error,
    tally: steps.length > 0 && revealed === steps.length ? toTally(steps) : null,
    repair,
  }
}
