import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { blockForNode, buildBlockPage, LINE_HEIGHT, type Block } from '../src/lib/fileblocks.ts'
import { buildFileGraph, fileList, footerLine, summaryLine } from '../src/lib/filegraph.ts'
import { fileHash, fileRoute, isWorkspace } from '../src/lib/route.ts'
import type { Graph } from '../src/types/contracts/graph.schema'

const root = new URL('../../', import.meta.url)
const load = (name: string) => JSON.parse(readFileSync(new URL(`data/${name}/graph.json`, root), 'utf8')) as Graph

const real = load('fastapi-template')
const mock = load('mock')
const REAL_SOURCE = 'third_party/fastapi-template/'
const MOCK_SOURCE = 'data/mock/source/'
const CRUD = 'backend/app/crud.py'
const DEPS = 'backend/app/api/deps.py'
const MODELS = 'backend/app/models.py'
const UTILS = 'backend/app/utils.py'
const CONFIG = 'backend/app/core/config.py'

function page(graph: Graph, file: string) {
  const result = buildFileGraph(graph, file)
  assert.ok(result, file)
  return result
}

function readSources(graph: Graph, base: string) {
  const sources = new Map<string, string[]>()
  for (const file of fileList(graph)) {
    sources.set(file, readFileSync(new URL(base + file, root), 'utf8').trimEnd().split('\n'))
  }
  return sources
}

const realSources = readSources(real, REAL_SOURCE)
const mockSources = readSources(mock, MOCK_SOURCE)

function everyBlockPage() {
  return [
    ...fileList(real).filter((file) => realSources.get(file)!.join('').trim()).map((file) => ({ file, lines: realSources.get(file)!, built: buildBlockPage(page(real, file), realSources) })),
    ...fileList(mock).filter((file) => mockSources.get(file)!.join('').trim()).map((file) => ({ file, lines: mockSources.get(file)!, built: buildBlockPage(page(mock, file), mockSources) })),
  ]
}

const own = (blocks: Block[], file: string) => blocks.filter((block) => block.file === file && block.kind !== 'unknown')

test('an unknown file has no graph', () => {
  assert.equal(buildFileGraph(real, 'backend/app/nope.py'), null)
})

test('every node and edge in a file graph is a real one', () => {
  for (const graph of [real, mock]) {
    const ids = new Set(graph.nodes)
    const edges = new Set(graph.edges)
    for (const file of fileList(graph)) {
      const { graph: subset } = page(graph, file)
      assert.ok(subset.nodes.every((node) => ids.has(node)))
      assert.ok(subset.edges.every((edge) => edges.has(edge)))
      assert.ok(subset.edges.every((edge) => edge.type !== 'imports'))
    }
  }
})

test('every line of a file that is not blank lands in exactly one block', () => {
  for (const { file, lines, built } of everyBlockPage()) {
    const blocks = own(built.blocks, file)
    lines.forEach((text, index) => {
      const line = index + 1
      const holders = blocks.filter((block) => line >= block.start && line <= block.end)
      assert.ok(holders.length <= 1, `${file}:${line} is in ${holders.map((block) => block.id)}`)
      if (text.trim()) assert.equal(holders.length, 1, `${file}:${line} is in no block: ${text}`)
    })
  }
})

test('every function, method and dependency in a file gets its own block', () => {
  for (const graph of [real, mock]) {
    const sources = graph === real ? realSources : mockSources
    for (const file of fileList(graph)) {
      if (!sources.get(file)!.join('').trim()) continue
      const { blocks } = buildBlockPage(page(graph, file), sources)
      const ids = new Set(blocks.map((block) => block.nodeId))
      const wanted = graph.nodes.filter((node) => node.file === file && ['function', 'class', 'dependency'].includes(node.type))
      for (const node of wanted) assert.ok(ids.has(node.id), `${node.id} has no block`)
    }
  }
})

test('a route is shown on its handler rather than as a block of its own', () => {
  const { blocks } = buildBlockPage(page(real, 'backend/app/api/routes/login.py'), realSources)
  const handler = blocks.find((block) => block.title === 'login_access_token')
  assert.equal(handler?.kicker, 'POST /api/v1/login/access-token')
  assert.ok(blocks.every((block) => !block.title.startsWith('POST ')))
})

test('a decorator stays with the function under it', () => {
  const { blocks } = buildBlockPage(page(real, 'backend/app/api/routes/login.py'), realSources)
  const lines = realSources.get('backend/app/api/routes/login.py')!
  const handler = blocks.find((block) => block.title === 'login_access_token')!
  assert.ok(lines[handler.start - 1].trimStart().startsWith('@'))
})

test('imports and constants get their own titled blocks', () => {
  const titles = own(buildBlockPage(page(real, CRUD), realSources).blocks, CRUD).map((block) => block.title)
  assert.equal(titles[0], 'imports')
  assert.ok(titles.includes('DUMMY_HASH'))
})

test('a class with methods is cut into its own lines and one block per method', () => {
  const { blocks, frames } = buildBlockPage(page(real, CONFIG), realSources)
  const members = blocks.filter((block) => block.owner === 'app.core.config:Settings')
  assert.ok(members.some((block) => block.title === 'Settings' && block.kicker === 'class'))
  assert.equal(members.filter((block) => block.kicker === 'method').length, 5)
  assert.deepEqual(frames.map((frame) => frame.id), ['app.core.config:Settings'])
})

test('an arrow leaves from the line the parser recorded for the call', () => {
  const { blocks, arrows } = buildBlockPage(page(real, CRUD), realSources)
  const source = blocks.find((block) => block.title === 'authenticate')!
  const edge = real.edges.find((item) => item.source === 'app.crud:authenticate' && item.target === 'app.crud:get_user_by_email')!
  const arrow = arrows.find((item) => item.id === `app.crud:authenticate:${edge.line}>app.crud:get_user_by_email`)
  assert.ok(arrow)
  const startY = Number(arrow.path.split(' ')[2])
  assert.equal(startY, source.y + 50 + 12 + (edge.line! - source.start + 0.5) * LINE_HEIGHT)
})

test('other files show as real code blocks, and callers as one card per file', () => {
  const { blocks, cards, arrows } = buildBlockPage(page(real, CRUD), realSources)
  const foreign = blocks.filter((block) => block.kind === 'foreign').map((block) => block.title).sort()
  assert.deepEqual(foreign, ['get_password_hash', 'verify_password'])
  assert.equal(cards.length, 3)
  assert.ok(arrows.some((arrow) => arrow.to === 'app.core.security:verify_password' && arrow.from === 'app.crud:authenticate'))
})

test('a call to code outside the repo is listed on its block, not drawn', () => {
  const { blocks } = buildBlockPage(page(real, CRUD), realSources)
  const block = blocks.find((item) => item.title === 'create_item')!
  assert.ok(block.outside.includes('session.add'))
})

test('a block of module code is never picked by a node id', () => {
  const built = buildBlockPage(page(real, CRUD), realSources)
  assert.equal(blockForNode(built, 'app.crud:authenticate', CRUD), 'app.crud:authenticate')
  assert.equal(blockForNode(built, 'app.core.security:verify_password', CRUD), null)
  assert.ok(built.blocks.some((block) => block.nodeId === null))
})

test('every arrow joins two things on the page', () => {
  for (const { built } of everyBlockPage()) {
    const ids = new Set([...built.blocks.map((block) => block.id), ...built.cards.map((card) => card.id)])
    for (const arrow of built.arrows) assert.ok(ids.has(arrow.from) && ids.has(arrow.to), arrow.id)
  }
})

test('no two blocks or cards overlap once laid out', () => {
  for (const { file, built } of everyBlockPage()) {
    const boxes = [...built.blocks, ...built.cards]
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) {
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
        assert.ok(apart, `${file}: ${a.id} overlaps ${b.id}`)
      }
    }
  }
})

test('the same input gives the same page', () => {
  for (const file of [CRUD, UTILS, MODELS]) {
    assert.deepEqual(buildBlockPage(page(real, file), realSources), buildBlockPage(page(real, file), realSources))
  }
})

test('crud matches the counts in the plan', () => {
  assert.deepEqual(page(real, CRUD).summary, {
    members: '5 functions',
    internal: 1,
    inbound: 13,
    inboundFiles: 3,
    outbound: 4,
    outboundFiles: 1,
    outside: 20,
    repoCalls: 5,
    repoCallsResolved: 5,
  })
})

test('deps and models count their wiring', () => {
  assert.equal(page(real, DEPS).summary.internal, 3)
  assert.equal(page(real, DEPS).summary.inbound, 37)
  assert.equal(page(real, MODELS).summary.members, '19 classes, 1 function')
  assert.equal(footerLine(page(real, MODELS).summary), 'no repo calls · 26 outside, by rule')
})

test('the summary and footer lines read as written in the plan', () => {
  const { summary } = page(real, CRUD)
  assert.equal(summaryLine(summary), '5 functions · 1 internal · 13 in from 3 files · 4 out to 1 file · 20 outside')
  assert.equal(footerLine(summary), '5/5 repo calls resolved · 20 outside, by rule')
})

test('an empty file has no canvas, and a file of only module code does', () => {
  assert.equal(page(real, 'backend/app/__init__.py').hasCanvas, false)
  assert.equal(page(real, 'backend/app/api/main.py').hasCanvas, true)
})

test('routes round-trip, including characters that need encoding', () => {
  assert.equal(fileHash('backend/app/api/routes/users.py'), '#/app/file/backend/app/api/routes/users.py')
  for (const file of [CRUD, 'a b/c#d.py', 'é/ü.py']) assert.equal(fileRoute(fileHash(file)), file)
})

test('the workspace owns every route under #/app and nothing else', () => {
  assert.equal(fileRoute('#/app'), null)
  assert.equal(fileRoute('#/'), null)
  assert.ok(isWorkspace('#/app'))
  assert.ok(isWorkspace(fileHash(CRUD)))
  assert.ok(!isWorkspace('#/application'))
  assert.ok(!isWorkspace(''))
})
