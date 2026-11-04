import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import { awaitsStep, deriveRun, isRevealing, nextDelay, type RunView } from '../src/lib/run.ts'
import type { AgentRun, Playback } from '../src/store.ts'
import type { AgentEvent, PathStep } from '../src/types/contracts/events.schema'
import type { Graph } from '../src/types/contracts/graph.schema'

const root = new URL('../../', import.meta.url)
const graph = JSON.parse(readFileSync(new URL('data/mock/graph.json', root), 'utf8')) as Graph
const real = JSON.parse(readFileSync(new URL('data/fastapi-template/graph.json', root), 'utf8')) as Graph

const ROUTE = 'taskboard.api.auth:POST /api/login'
const LOGIN = 'taskboard.api.auth:login'
const AUTHENTICATE = 'taskboard.services.users:UserService.authenticate'
const NO_EDGE = 'No edge in the graph joins POST /api/login to authenticate.'

const step = (nodeId: string, ...claims: PathStep['claims']): PathStep => ({
  node_id: nodeId,
  explanation: `at ${nodeId}`,
  claims: [{ text: `where ${nodeId}`, status: 'verified' }, ...claims],
})
const gapStep = (nodeId: string, ...claims: PathStep['claims']): PathStep => ({
  node_id: nodeId,
  explanation: `at ${nodeId}`,
  claims: [{ text: NO_EDGE, status: 'gap' }, ...claims],
})

const WEAK = { text: 'The form is passed on.', status: 'unverified' } as const
const STRONG = { text: 'The form is passed on.', status: 'verified', quote: 'users.authenticate(form)' } as const

const firstDraft = [step(ROUTE), gapStep(AUTHENTICATE, WEAK)]
const repairedPath = [step(ROUTE), step(LOGIN), step(AUTHENTICATE, STRONG)]

const started: AgentEvent = {
  type: 'repair_started',
  issues: [
    { kind: 'gap', node_id: AUTHENTICATE, text: NO_EDGE },
    { kind: 'claim', node_id: AUTHENTICATE, text: WEAK.text },
  ],
  left_alone: 2,
}

function repairRun(outcome: 'accepted' | 'no_improvement' | 'failed'): AgentEvent[] {
  const steps = outcome === 'accepted' ? repairedPath : []
  return [
    { type: 'run_started' },
    { type: 'node_visited', node_id: ROUTE, reason: 'read' },
    { type: 'final_path', steps: firstDraft },
    started,
    { type: 'repair_finished', outcome, steps },
    { type: 'done' },
  ]
}

// Advances playback exactly as the store does, keeping every frame.
function play(events: AgentEvent[], from: Graph = graph): RunView[] {
  const run: AgentRun = { status: 'done', question: 'q', events }
  let playback: Playback = { cursor: 0, pathStep: 0 }
  const frames = [deriveRun(from, run, playback)]
  for (let guard = 0; guard < 2000 && nextDelay(events, playback) !== null; guard += 1) {
    playback = isRevealing(events, playback)
      ? { ...playback, pathStep: playback.pathStep + 1 }
      : { ...playback, cursor: playback.cursor + 1 }
    frames.push(deriveRun(from, run, playback))
  }
  return frames
}

const last = <T>(items: T[]) => items[items.length - 1]
const nodeIds = (view: RunView) => view.stars.map((star) => star.nodeId)

test('a run with no repair events has no repair view and no added steps', () => {
  const frames = play([{ type: 'run_started' }, { type: 'final_path', steps: firstDraft }, { type: 'done' }])
  assert.ok(frames.every((frame) => frame.repair === null))
  assert.ok(frames.every((frame) => frame.stars.every((star) => !star.added)))
  assert.equal(last(frames).phase, 'settled')
})

test('while the agent repairs, the first answer stays up and the map points at what was sent back', () => {
  const frame = play(repairRun('accepted')).find((view) => view.repair?.stage === 'repairing')
  assert.ok(frame)
  assert.deepEqual(nodeIds(frame), [ROUTE, AUTHENTICATE])
  assert.equal(frame.current, AUTHENTICATE)
  assert.equal(frame.caption, `Sent back: ${NO_EDGE}`)
  assert.equal(frame.repair?.leftAlone, 2)
  assert.equal(frame.phase, 'revealing')
})

test('the hold after the issues are sent back is long enough to read them', () => {
  const events = repairRun('accepted')
  const delay = nextDelay(events, { cursor: 4, pathStep: firstDraft.length })
  assert.ok(delay !== null && delay >= 2000)
})

test('a live run waits on the repair without settling', () => {
  const events = repairRun('accepted').slice(0, 4)
  const run: AgentRun = { status: 'running', question: 'q', events }
  const playback = { cursor: 4, pathStep: firstDraft.length }
  assert.equal(nextDelay(events, playback), null)
  assert.equal(deriveRun(graph, run, playback).phase, 'revealing')
})

test('an accepted repair ends on the repaired path with the gap solid and the bridge marked as added', () => {
  const end = last(play(repairRun('accepted')))
  assert.equal(end.phase, 'settled')
  assert.deepEqual(nodeIds(end), [ROUTE, LOGIN, AUTHENTICATE])
  assert.deepEqual(end.stars.map((star) => star.added), [false, true, false])
  assert.ok(end.segments.every((segment) => !segment.dashed))
  assert.deepEqual(end.tally, { verified: 4, unverified: 0, gap: 0 })
})

test('the first answer shows a dashed gap before the repair', () => {
  const frame = play(repairRun('accepted')).find((view) => view.repair?.stage === 'repairing')
  assert.ok(frame?.segments[0].dashed)
})

test('the first-draft tally stays on screen after the repair', () => {
  const end = last(play(repairRun('accepted')))
  assert.deepEqual(end.repair?.firstTally, { verified: 1, unverified: 1, gap: 1 })
  assert.deepEqual(end.repair?.finalTally, { verified: 4, unverified: 0, gap: 0 })
})

test('each issue says whether it was fixed', () => {
  const end = last(play(repairRun('accepted')))
  assert.deepEqual(end.repair?.lines.map((line) => line.fixed), [true, true])
  assert.ok(end.repair?.fixedClaims.has(WEAK.text))
})

test('an issue that stayed flagged is not shown as fixed', () => {
  const stillWeak = [step(ROUTE), step(LOGIN), step(AUTHENTICATE, WEAK)]
  const events = repairRun('accepted').map((event) => (event.type === 'repair_finished' ? { ...event, steps: stillWeak } : event))
  assert.deepEqual(last(play(events)).repair?.lines.map((line) => line.fixed), [true, false])
})

test('the repair only redraws from the first step it changed', () => {
  const frames = play(repairRun('accepted'))
  const drawing = frames.slice(frames.findIndex((view) => view.repair?.stage === 'accepted'))
  assert.ok(drawing.every((view) => view.revealed >= 1))
})

test('no step of the path leaves the screen while a repair draws', () => {
  const frames = play(repairRun('accepted'))
  const drawing = frames.slice(frames.findIndex((view) => view.repair?.stage === 'accepted'))
  assert.ok(drawing.length > 1)
  for (const frame of drawing) {
    assert.ok(nodeIds(frame).includes(ROUTE))
    assert.ok(nodeIds(frame).includes(AUTHENTICATE))
  }
})

test('a repair that adds no node still reveals and settles', () => {
  const claimsOnly = [step(ROUTE), gapStep(AUTHENTICATE, STRONG)]
  const events = repairRun('accepted').map((event) => (event.type === 'repair_finished' ? { ...event, steps: claimsOnly } : event))
  const end = last(play(events))
  assert.equal(end.phase, 'settled')
  assert.equal(end.revealed, 2)
  assert.deepEqual(end.tally, { verified: 2, unverified: 0, gap: 1 })
})

for (const outcome of ['no_improvement', 'failed'] as const) {
  test(`a ${outcome} repair keeps the first answer, with no error`, () => {
    const end = last(play(repairRun(outcome)))
    assert.equal(end.phase, 'settled')
    assert.deepEqual(nodeIds(end), [ROUTE, AUTHENTICATE])
    assert.equal(end.error, null)
    assert.equal(end.repair?.stage, outcome)
    assert.equal(end.repair?.finalTally, null)
    assert.ok(end.repair?.lines.every((line) => !line.fixed))
    assert.ok(end.segments[0].dashed)
  })
}

test('every cached answer replays to the end, and shows a repair only if it holds one', () => {
  const folder = new URL('data/fastapi-template/answers/', root)
  for (const name of readdirSync(folder)) {
    const lines = readFileSync(new URL(name, folder), 'utf8').split('\n').filter(Boolean)
    const events = lines.map((line) => JSON.parse(line) as AgentEvent)
    const end = last(play(events, real))
    assert.equal(end.phase, 'settled', name)
    assert.equal(end.repair !== null, events.some((event) => event.type === 'repair_started'), name)
  }
})

test('manual mode shows the first step by itself and waits before every later one', () => {
  const events = [{ type: 'run_started' }, { type: 'final_path', steps: firstDraft }, { type: 'done' }] as AgentEvent[]
  const atFinalPath = { cursor: 2, pathStep: 0 }
  assert.equal(awaitsStep(events, atFinalPath), false)
  for (let step = 1; step < firstDraft.length; step += 1) assert.equal(awaitsStep(events, { cursor: 2, pathStep: step }), true)
  assert.equal(awaitsStep(events, { cursor: 2, pathStep: firstDraft.length }), false)
})

test('manual mode waits after a repair is sent back, and never during the investigation', () => {
  const events = repairRun('accepted')
  assert.equal(awaitsStep(events, { cursor: 4, pathStep: firstDraft.length }), true)
  assert.equal(awaitsStep(events, { cursor: 1, pathStep: 0 }), false)
})
