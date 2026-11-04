import type { AgentEvent, PathStep } from '@/types/contracts/events.schema'

// The agent loop as the inspector shows it: four stages, and the tool calls inside the first. Times come from when each
// event reached the browser, so they exist only for live runs. A recorded run replays at a fixed pace, and its real
// timings were never saved, so it has none rather than made-up ones.

export const MAX_TOOL_CALLS = 8

export type StageState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type StageKey = 'investigate' | 'answer' | 'validate' | 'repair'

export interface ToolRow {
  index: number
  name: string
  args: [string, string][]
  summary: string | null
  visited: string[]
  // How long the model took to ask for this call, from the event before it. Most of a run is spent here.
  modelMs: number | null
  // How long the tool itself took to answer.
  ms: number | null
}

export interface Stage {
  key: StageKey
  state: StageState
  ms: number | null
}

export interface Tally {
  verified: number
  unverified: number
  gap: number
}

export interface TraceView {
  stages: Stage[]
  tools: ToolRow[]
  firstTally: Tally | null
  firstSteps: number | null
  repair: {
    sentBack: number
    leftAlone: number
    outcome: 'accepted' | 'no_improvement' | 'failed' | null
    // The repaired path's counts, when the repair was accepted.
    finalTally: Tally | null
  } | null
  error: string | null
  totalMs: number | null
}

// When the run started and when each event arrived, in milliseconds. Null for a recorded run.
export interface Timing {
  startedAt: number
  received: number[]
}

function tally(steps: PathStep[]): Tally {
  const counts = { verified: 0, unverified: 0, gap: 0 }
  for (const claim of steps.flatMap((step) => step.claims)) counts[claim.status] += 1
  return counts
}

// events are the ones shown so far, so the trace keeps pace with the map. timing covers every event that arrived.
export function deriveTrace(events: AgentEvent[], timing: Timing | null): TraceView {
  const at = (index: number) => (timing && index >= 0 ? (timing.received[index] ?? null) : null)
  const span = (from: number | null, to: number | null) => (from !== null && to !== null ? Math.max(0, to - from) : null)

  const tools: ToolRow[] = []
  const calledAt = new Map<number, number>()
  let lastToolEvent = -1
  let finalAt = -1
  let repairStartedAt = -1
  let repairFinishedAt = -1
  let doneAt = -1
  let firstTally: Tally | null = null
  let firstSteps: number | null = null
  let repair: TraceView['repair'] = null
  let error: string | null = null

  for (const [index, event] of events.entries()) {
    if (event.type === 'tool_call') {
      calledAt.set(event.call_index, index)
      const args = Object.entries(event.args).map(([key, value]): [string, string] => [key, String(value)])
      const before = index > 0 ? at(index - 1) : (timing?.startedAt ?? null)
      tools.push({
        index: event.call_index,
        name: event.name,
        args,
        summary: null,
        visited: [],
        modelMs: span(before, at(index)),
        ms: null,
      })
      lastToolEvent = index
    } else if (event.type === 'tool_result') {
      const row = tools.find((tool) => tool.index === event.call_index)
      if (row) {
        row.summary = event.summary
        row.ms = span(at(calledAt.get(event.call_index) ?? -1), at(index))
      }
      lastToolEvent = index
    } else if (event.type === 'node_visited') {
      tools.at(-1)?.visited.push(event.node_id)
    } else if (event.type === 'final_path') {
      finalAt = index
      firstTally = tally(event.steps)
      firstSteps = event.steps.length
    } else if (event.type === 'repair_started') {
      repairStartedAt = index
      repair = {
        sentBack: event.issues.length,
        leftAlone: event.left_alone,
        outcome: null,
        finalTally: null,
      }
    } else if (event.type === 'repair_finished') {
      repairFinishedAt = index
      if (repair) {
        repair.outcome = event.outcome
        if (event.outcome === 'accepted') repair.finalTally = tally(event.steps)
      }
    } else if (event.type === 'error') {
      error = event.message
    } else if (event.type === 'done') {
      doneAt = index
    }
  }

  const answered = finalAt >= 0
  const failed = error !== null
  const investigateEnd = lastToolEvent >= 0 ? at(lastToolEvent) : null

  let investigate: StageState = 'running'
  if (answered) investigate = 'done'
  else if (failed) investigate = 'failed'

  let answer: StageState = 'pending'
  if (answered) answer = 'done'
  else if (failed) answer = 'skipped'

  let repairState: StageState = 'pending'
  if (repair) {
    if (repair.outcome === null) repairState = failed ? 'failed' : 'running'
    else repairState = repair.outcome === 'failed' ? 'failed' : 'done'
  } else if ((answered && doneAt >= 0) || failed) {
    // Nothing was flagged, or the run stopped before there was anything to repair.
    repairState = 'skipped'
  }

  const lastAt = at(events.length - 1)
  return {
    stages: [
      {
        key: 'investigate',
        state: investigate,
        ms: span(timing?.startedAt ?? null, answered ? investigateEnd : null),
      },
      {
        key: 'answer',
        state: answer,
        ms: answered ? span(investigateEnd ?? timing?.startedAt ?? null, at(finalAt)) : null,
      },
      {
        key: 'validate',
        state: answered ? 'done' : failed ? 'skipped' : 'pending',
        ms: null,
      },
      {
        key: 'repair',
        state: repairState,
        ms: span(at(repairStartedAt), at(repairFinishedAt)),
      },
    ],
    tools,
    firstTally,
    firstSteps,
    repair,
    error,
    totalMs: doneAt >= 0 || failed ? span(timing?.startedAt ?? null, lastAt) : null,
  }
}

export function formatMs(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
