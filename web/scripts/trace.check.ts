import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { deriveTrace, formatMs } from '../src/lib/trace.ts'
import type { AgentEvent } from '../src/types/contracts/events.schema'

const ANSWERS = new URL('../../data/fastapi-template/answers/', import.meta.url)

function recorded(name: string): AgentEvent[] {
  return readFileSync(new URL(name, ANSWERS), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const stateOf = (events: AgentEvent[]) => Object.fromEntries(deriveTrace(events, null).stages.map((stage) => [stage.key, stage.state]))

test('the repair take reads as eight tool calls, an answer, a check and an accepted repair', () => {
  const view = deriveTrace(recorded('how-does-a-user-log-in.jsonl'), null)
  assert.equal(view.tools.length, 8)
  assert.ok(view.tools.every((tool) => tool.summary !== null))
  assert.deepEqual(view.firstTally, { verified: 12, unverified: 4, gap: 1 })
  assert.equal(view.repair?.outcome, 'accepted')
  assert.deepEqual(view.repair?.finalTally, { verified: 18, unverified: 0, gap: 0 })
  assert.deepEqual(
    view.stages.map((stage) => stage.state),
    ['done', 'done', 'done', 'done'],
  )
})

test('a recorded run has no timings at all', () => {
  const view = deriveTrace(recorded('how-does-a-user-log-in.jsonl'), null)
  assert.equal(view.totalMs, null)
  assert.ok(view.stages.every((stage) => stage.ms === null))
  assert.ok(view.tools.every((tool) => tool.ms === null && tool.modelMs === null))
})

test('nodes the agent visited are listed under the call that reached them', () => {
  const view = deriveTrace(recorded('how-does-a-user-log-in.jsonl'), null)
  assert.deepEqual(view.tools[1].visited, ['app.api.routes.login:login_access_token'])
})

test('while the agent investigates, the later stages wait', () => {
  const events = recorded('how-does-a-user-log-in.jsonl').slice(0, 4)
  assert.deepEqual(stateOf(events), { investigate: 'running', answer: 'pending', validate: 'pending', repair: 'pending' })
})

test('a run with nothing flagged skips repair once it is done', () => {
  const steps = [{ node_id: 'a', explanation: 'x', claims: [{ text: 't', status: 'verified', quote: 'q' }] }]
  const events = [{ type: 'run_started' }, { type: 'final_path', steps }, { type: 'done' }] as AgentEvent[]
  assert.equal(stateOf(events).repair, 'skipped')
  assert.equal(stateOf(events.slice(0, 2)).repair, 'pending')
})

test('an error before the answer fails the investigation and skips the rest', () => {
  const events = [{ type: 'run_started' }, { type: 'error', message: 'no key' }] as AgentEvent[]
  const view = deriveTrace(events, null)
  assert.deepEqual(stateOf(events), { investigate: 'failed', answer: 'skipped', validate: 'skipped', repair: 'skipped' })
  assert.equal(view.error, 'no key')
})

test('live timings come from when events arrived', () => {
  const events = [
    { type: 'run_started' },
    { type: 'tool_call', name: 'find_routes', args: { query: 'login' }, call_index: 0 },
    { type: 'tool_result', call_index: 0, summary: '2 routes found.' },
    { type: 'final_path', steps: [] },
    { type: 'done' },
  ] as AgentEvent[]
  const view = deriveTrace(events, { startedAt: 1000, received: [1010, 1200, 1500, 9500, 9600] })
  assert.equal(view.tools[0].ms, 300)
  assert.equal(view.tools[0].modelMs, 190)
  assert.equal(view.stages[0].ms, 500)
  assert.equal(view.stages[1].ms, 8000)
  assert.equal(view.totalMs, 8600)
})

test('durations read as milliseconds under a second and seconds above', () => {
  assert.equal(formatMs(240), '240ms')
  assert.equal(formatMs(8040), '8.0s')
  assert.equal(formatMs(null), '')
})
