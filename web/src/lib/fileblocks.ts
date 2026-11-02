import type { FileGraph } from './filegraph.ts'
import type { Graph } from '../types/contracts/graph.schema'

// Cuts one file into blocks of its real code and lays them out as a graph. Every line that isn't blank lands in exactly one
// block, and an arrow leaves from the line the parser recorded for the call. Sizes are fixed in model units, so a line's
// position can be worked out here without measuring the page.
// No value imports from '@/': `make test-web` runs this file directly under node.

type GraphNode = Graph['nodes'][number]
type GraphEdge = Graph['edges'][number]

export const LINE_HEIGHT = 18
export const HEADER_HEIGHT = 50
export const CODE_PADDING = 12
export const CARD_HEADER = 42
export const CARD_ROW = 26

const CHAR_WIDTH = 7.25
const MIN_WIDTH = 340
const MAX_WIDTH = 580
const CARD_WIDTH = 300
const BLOCK_GAP = 24
const COLUMN_GAP = 110
const COLUMN_LIMITS = [700, 900, 1100, 1300, 1500, 1800, 2200]
// The shape of the frame at the smallest supported size, so the page is laid out to be drawn as large as it can be.
const FRAME = { width: 1216, height: 572 }
const FOREIGN_LINES = 12
const CURVE = 0.5
const MIN_CURVE = 60

export type BlockKind = 'function' | 'class' | 'dependency' | 'code' | 'foreign' | 'unknown'

export interface Block {
  id: string
  nodeId: string | null
  file: string
  title: string
  kicker: string
  kind: BlockKind
  start: number
  end: number
  clipped: number
  owner: string | null
  outside: string[]
  x: number
  y: number
  stackY: number
  width: number
  height: number
}

export interface CallerRow {
  nodeId: string
  name: string
  target: string
}

export interface CallerCard {
  id: string
  file: string
  rows: CallerRow[]
  x: number
  y: number
  width: number
  height: number
}

export interface ClassFrame {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface Arrow {
  id: string
  from: string
  to: string
  path: string
  line: number | null
  kind: 'call' | 'wiring'
  broken: boolean
}

export interface Bounds {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface BlockPage {
  blocks: Block[]
  cards: CallerCard[]
  frames: ClassFrame[]
  arrows: Arrow[]
  stackBounds: Bounds
  bounds: Bounds
}

interface Range {
  start: number
  end: number
}

function isBlank(line: string | undefined) {
  return line === undefined || line.trim() === ''
}

// The lines of a range that aren't blank, split wherever blank lines separate them.
function paragraphs({ start, end }: Range, lines: string[]): Range[] {
  const found: Range[] = []
  let open: number | null = null
  for (let line = start; line <= end + 1; line += 1) {
    const blank = line > end || isBlank(lines[line - 1])
    if (!blank && open === null) open = line
    if (blank && open !== null) {
      found.push({ start: open, end: line - 1 })
      open = null
    }
  }
  return found
}

function withoutRanges(whole: Range, taken: Range[]): Range[] {
  const free: Range[] = []
  let cursor = whole.start
  for (const range of [...taken].sort((a, b) => a.start - b.start)) {
    if (range.start > cursor) free.push({ start: cursor, end: range.start - 1 })
    cursor = Math.max(cursor, range.end + 1)
  }
  if (cursor <= whole.end) free.push({ start: cursor, end: whole.end })
  return free
}

function isImport(text: string) {
  return /^(from\s+\S+\s+import\b|import\s)/.test(text)
}

// Decorators sit directly above a definition, and may be several lines long.
function withDecorators(range: Range, lines: string[], floor: number): Range {
  let top = range.start - 1
  while (top >= floor && !isBlank(lines[top - 1])) top -= 1
  const start = top + 1
  return start < range.start && lines[start - 1].trimStart().startsWith('@') ? { ...range, start } : range
}

function codeTitle(range: Range, lines: string[]) {
  const text = lines.slice(range.start - 1, range.end)
  if (isImport(text[0].trimStart())) return 'imports'
  const names = text.flatMap((line) => /^([A-Za-z_]\w*)\s*(?::[^=]+)?=/.exec(line)?.[1] ?? [])
  if (names.length > 0) return names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '')
  if (text[0].trimStart().startsWith('"""')) return 'file docstring'
  return 'module code'
}

// Paragraphs of imports join up, so one file's imports are one block.
function codeRanges(free: Range[], lines: string[]): Range[] {
  const merged: Range[] = []
  for (const gap of free) {
    for (const part of paragraphs(gap, lines)) {
      const last = merged.at(-1)
      const bothImports = last && isImport(lines[last.start - 1]) && isImport(lines[part.start - 1])
      if (last && bothImports && !lines.slice(last.end, part.start - 1).some((line) => !isBlank(line))) last.end = part.end
      else merged.push({ ...part })
    }
  }
  return merged
}

function blockWidth(range: Range, lines: string[]) {
  const longest = Math.max(...lines.slice(range.start - 1, range.end).map((line) => line.length), 0)
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest * CHAR_WIDTH + CODE_PADDING * 2 + 44))
}

function codeHeight(lineCount: number) {
  return HEADER_HEIGHT + lineCount * LINE_HEIGHT + CODE_PADDING * 2
}

function makeBlock(
  fields: Pick<Block, 'id' | 'nodeId' | 'file' | 'title' | 'kicker' | 'kind' | 'owner'>,
  range: Range,
  lines: string[],
): Block {
  return {
    ...fields,
    ...range,
    clipped: 0,
    outside: [],
    x: 0,
    y: 0,
    stackY: 0,
    width: blockWidth(range, lines),
    height: codeHeight(range.end - range.start + 1),
  }
}

function cutFile(page: FileGraph, lines: string[]) {
  const { file } = page
  const nodes = page.graph.nodes.filter((node) => node.file === file)
  const definitions = nodes.filter((node) => ['function', 'class', 'dependency'].includes(node.type))
  const classes = definitions.filter((node) => node.type === 'class')
  const ownerOf = (node: GraphNode) => classes.find((owner) => node.id.startsWith(`${owner.id}.`)) ?? null
  const hasMembers = (node: GraphNode) => definitions.some((other) => ownerOf(other)?.id === node.id)

  const leaves = definitions
    .filter((node) => !hasMembers(node))
    .sort((a, b) => a.line_start - b.line_start || b.line_end - a.line_end)
  const kept: { node: GraphNode; range: Range }[] = []
  const blockOfNode = new Map<string, string>()
  for (const node of leaves) {
    const outer = kept.find(({ range }) => node.line_start >= range.start && node.line_end <= range.end)
    if (outer) {
      blockOfNode.set(node.id, outer.node.id)
      continue
    }
    const floor = (kept.at(-1)?.range.end ?? 0) + 1
    kept.push({ node, range: withDecorators({ start: node.line_start, end: node.line_end }, lines, floor) })
  }

  const routesOf = new Map<string, string[]>()
  for (const edge of page.graph.edges) {
    if (edge.type !== 'routes_to') continue
    const route = page.graph.nodes.find((node) => node.id === edge.source)
    if (route) routesOf.set(edge.target, [...(routesOf.get(edge.target) ?? []), route.name])
  }

  const blocks: Block[] = kept.map(({ node, range }) => {
    const owner = ownerOf(node)
    const kicker = routesOf.get(node.id)?.join(', ') ?? (owner ? 'method' : node.type)
    const kind = node.type === 'class' ? 'class' : node.type === 'dependency' ? 'dependency' : 'function'
    return makeBlock(
      { id: node.id, nodeId: node.id, file, title: node.name, kicker, kind, owner: owner?.id ?? null },
      range,
      lines,
    )
  })

  // A class with methods becomes its own lines plus one block per method.
  const claimed: Range[] = kept.map(({ range }) => range)
  for (const owner of classes.filter(hasMembers)) {
    const inside = kept.filter(({ node }) => ownerOf(node)?.id === owner.id).map(({ range }) => range)
    const spans = withoutRanges({ start: owner.line_start, end: owner.line_end }, inside)
      .flatMap((range) => paragraphs(range, lines))
      .reduce<Range[]>((joined, part) => {
        const last = joined.at(-1)
        const touching = last && !inside.some((range) => range.start > last.end && range.start < part.start)
        if (last && touching) last.end = part.end
        else joined.push({ ...part })
        return joined
      }, [])
    spans.forEach((range, index) => {
      const id = index === 0 ? owner.id : `${owner.id}#${index}`
      const title = index === 0 ? owner.name : `${owner.name}, continued`
      const fields = { id, nodeId: index === 0 ? owner.id : null, file, title, kicker: 'class', kind: 'class' as const, owner: owner.id }
      blocks.push(makeBlock(fields, range, lines))
      claimed.push(range)
    })
  }

  const whole = { start: 1, end: Math.max(lines.length, 1) }
  for (const range of codeRanges(withoutRanges(whole, claimed), lines)) {
    const fields = {
      id: `code:${range.start}`,
      nodeId: null,
      file,
      title: codeTitle(range, lines),
      kicker: 'module code',
      kind: 'code' as const,
      owner: null,
    }
    blocks.push(makeBlock(fields, range, lines))
  }
  blocks.sort((a, b) => a.start - b.start)
  return { blocks, blockOfNode }
}

function foreignBlock(node: GraphNode, sources: Map<string, string[]>): Block {
  const fields = { id: node.id, nodeId: node.id, file: node.file, title: node.name, owner: null }
  if (node.type === 'unresolved') {
    const block = makeBlock({ ...fields, kicker: 'target not proven', kind: 'unknown' }, { start: 1, end: 0 }, [])
    return { ...block, height: HEADER_HEIGHT }
  }
  const lines = sources.get(node.file)
  if (!lines) {
    const block = makeBlock({ ...fields, kicker: node.file, kind: 'foreign' }, { start: 1, end: 0 }, [])
    return { ...block, height: HEADER_HEIGHT }
  }
  const range = { start: node.line_start, end: Math.min(node.line_end, node.line_start + FOREIGN_LINES - 1) }
  const clipped = node.line_end - range.end
  return { ...makeBlock({ ...fields, kicker: node.file, kind: 'foreign' }, range, lines), clipped }
}

interface Link {
  edge: GraphEdge
  source: Block
  target: Block
  line: number
}

function linkBlocks(page: FileGraph, blocks: Block[], blockOfNode: Map<string, string>, sources: Map<string, string[]>) {
  const byNode = new Map(page.graph.nodes.map((node) => [node.id, node]))
  const byId = new Map(blocks.map((block) => [block.id, block]))
  const own = (nodeId: string) => byId.get(blockOfNode.get(nodeId) ?? nodeId)
  const atLine = (line: number | null | undefined) =>
    line ? blocks.find((block) => line >= block.start && line <= block.end) : undefined

  const foreign = new Map<string, Block>()
  const links: Link[] = []
  const seen = new Set<string>()
  const callers = new Map<string, Map<string, CallerRow>>()
  for (const edge of page.graph.edges) {
    if (edge.type === 'routes_to') continue
    const from = byNode.get(edge.source)!
    const to = byNode.get(edge.target)!
    const inFile = from.file === page.file

    if (!inFile) {
      const target = own(edge.target)
      if (!target) continue
      const rows = callers.get(from.file) ?? new Map<string, CallerRow>()
      rows.set(`${from.id}>${target.id}`, { nodeId: from.id, name: from.name, target: target.id })
      callers.set(from.file, rows)
      continue
    }

    const source = (edge.source === page.module.id ? atLine(edge.line) : (own(edge.source) ?? atLine(edge.line))) ?? atLine(edge.line)
    if (!source) continue
    if (to.type === 'external') {
      if (!source.outside.includes(to.name)) source.outside.push(to.name)
      continue
    }
    let target = own(edge.target)
    if (!target && to.file !== page.file) {
      target = foreign.get(to.id) ?? foreignBlock(to, sources)
      foreign.set(to.id, target)
    }
    if (!target && to.type === 'unresolved') {
      target = foreign.get(to.id) ?? foreignBlock(to, sources)
      foreign.set(to.id, target)
    }
    if (!target || target === source) continue

    const inside = edge.line && edge.line >= source.start && edge.line <= source.end
    const line = inside ? edge.line! : source.start
    const key = `${source.id}:${line}>${target.id}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ edge, source, target, line })
  }
  return { foreign: [...foreign.values()], links, callers }
}

interface Unit {
  id: string
  blocks: Block[]
  start: number
  height: number
  width: number
}

function makeUnits(blocks: Block[]): Unit[] {
  const units = new Map<string, Unit>()
  for (const block of blocks) {
    const id = block.owner ?? block.id
    const unit = units.get(id) ?? { id, blocks: [], start: block.start, height: -BLOCK_GAP, width: 0 }
    unit.blocks.push(block)
    unit.height += block.height + BLOCK_GAP
    unit.width = Math.max(unit.width, block.width)
    units.set(id, unit)
  }
  return [...units.values()]
}

// Longest path from a unit nothing in the file calls. Cycles stop counting once every unit has been passed.
function depths(units: Unit[], links: Link[]) {
  const unitOf = (block: Block) => block.owner ?? block.id
  const known = new Set(units.map((unit) => unit.id))
  const pairs = links
    .map((link) => [unitOf(link.source), unitOf(link.target)] as const)
    .filter(([from, to]) => known.has(from) && known.has(to) && from !== to)
  const depth = new Map(units.map((unit) => [unit.id, 0]))
  for (let pass = 0; pass < units.length; pass += 1) {
    for (const [from, to] of pairs) {
      const next = depth.get(from)! + 1
      if (next > depth.get(to)! && next < units.length) depth.set(to, next)
    }
  }
  return depth
}

function placeColumn(units: { height: number; width: number; place: (x: number, y: number) => void }[], left: number, middle: number, limit: number) {
  const columns: (typeof units)[] = [[]]
  let used = 0
  for (const unit of units) {
    if (used > 0 && used + unit.height > limit) {
      columns.push([])
      used = 0
    }
    columns.at(-1)!.push(unit)
    used += unit.height + BLOCK_GAP
  }
  let x = left
  for (const column of columns) {
    const height = column.reduce((sum, unit) => sum + unit.height + BLOCK_GAP, -BLOCK_GAP)
    let y = middle - height / 2
    for (const unit of column) {
      unit.place(x, y)
      y += unit.height + BLOCK_GAP
    }
    x += Math.max(...column.map((unit) => unit.width), 0) + COLUMN_GAP
  }
  return x
}

function layOut(blocks: Block[], foreign: Block[], callers: Map<string, Map<string, CallerRow>>, links: Link[], limit: number) {
  const units = makeUnits(blocks)
  const depth = depths(units, links)
  const deepest = Math.max(...depth.values(), 0)

  const placeUnit = (unit: Unit, x: number, y: number) => {
    let top = y
    for (const block of unit.blocks) {
      block.x = x
      block.y = top
      top += block.height + BLOCK_GAP
    }
  }
  const asColumnUnit = (unit: Unit) => ({
    height: unit.height,
    width: unit.width,
    place: (x: number, y: number) => placeUnit(unit, x, y),
  })

  const cards: CallerCard[] = [...callers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, rows]) => {
      const list = [...rows.values()]
      return { id: `callers:${file}`, file, rows: list, x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEADER + list.length * CARD_ROW }
    })

  let x = placeColumn(
    cards.map((card) => ({
      height: card.height,
      width: card.width,
      place: (left: number, top: number) => {
        card.x = left
        card.y = top
      },
    })),
    0,
    0,
    limit,
  )
  if (cards.length === 0) x = 0
  for (let level = 0; level <= deepest; level += 1) {
    const inLevel = units.filter((unit) => depth.get(unit.id) === level).sort((a, b) => a.start - b.start)
    x = placeColumn(inLevel.map(asColumnUnit), x, 0, limit)
  }

  // Each outside block sits near the lines that reach it, so the arrows cross less.
  const reach = (block: Block) => {
    const ys = links.filter((link) => link.target === block).map((link) => link.source.y + (link.line - link.source.start) * LINE_HEIGHT)
    return ys.reduce((sum, y) => sum + y, 0) / (ys.length || 1)
  }
  const ordered = [...foreign].sort((a, b) => reach(a) - reach(b) || a.id.localeCompare(b.id))
  placeColumn(
    ordered.map((block) => ({
      height: block.height,
      width: block.width,
      place: (left: number, top: number) => {
        block.x = left
        block.y = top
      },
    })),
    x,
    0,
    limit,
  )
  return cards
}

function curve(from: { x: number; y: number }, to: { x: number; y: number }, enterFromRight: boolean) {
  const bend = Math.max(MIN_CURVE, Math.abs(to.x - from.x) * CURVE)
  const second = enterFromRight ? to.x + bend : to.x - bend
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${second} ${to.y}, ${to.x} ${to.y}`
}

function toArrow({ edge, source, target, line }: Link): Arrow {
  const from = {
    x: source.x + source.width,
    y: source.y + HEADER_HEIGHT + CODE_PADDING + (line - source.start + 0.5) * LINE_HEIGHT,
  }
  const enterFromRight = target.x < from.x
  const to = { x: enterFromRight ? target.x + target.width : target.x, y: target.y + HEADER_HEIGHT / 2 }
  return {
    id: `${source.id}:${line}>${target.id}`,
    from: source.id,
    to: target.id,
    path: curve(from, to, enterFromRight),
    line,
    kind: edge.type === 'calls' || edge.type === 'uncertain' ? 'call' : 'wiring',
    broken: !edge.resolved,
  }
}

function cardArrows(cards: CallerCard[], blocks: Block[]): Arrow[] {
  return cards.flatMap((card) => {
    const targets = [...new Set(card.rows.map((row) => row.target))]
    return targets.flatMap((target) => {
      const block = blocks.find((item) => item.id === target)!
      const index = card.rows.findIndex((row) => row.target === target)
      const from = { x: card.x + card.width, y: card.y + CARD_HEADER + (index + 0.5) * CARD_ROW }
      const to = { x: block.x, y: block.y + HEADER_HEIGHT / 2 }
      return { id: `${card.id}>${target}`, from: card.id, to: target, path: curve(from, to, false), line: null, kind: 'call' as const, broken: false }
    })
  })
}

function classFrames(blocks: Block[]): ClassFrame[] {
  const owners = [...new Set(blocks.flatMap((block) => block.owner ?? []))]
  return owners.flatMap((id) => {
    const members = blocks.filter((block) => block.owner === id)
    if (members.length < 2) return []
    const x = Math.min(...members.map((block) => block.x))
    const y = Math.min(...members.map((block) => block.y))
    const right = Math.max(...members.map((block) => block.x + block.width))
    const bottom = Math.max(...members.map((block) => block.y + block.height))
    return [{ id, x: x - 12, y: y - 12, width: right - x + 24, height: bottom - y + 24 }]
  })
}

export function blockForNode(built: BlockPage, nodeId: string, file: string) {
  return built.blocks.find((block) => block.nodeId === nodeId && block.file === file)?.id ?? null
}

export function boundsOf(boxes: { x: number; y: number; width: number; height: number }[]): Bounds {
  return {
    x1: Math.min(...boxes.map((box) => box.x)),
    y1: Math.min(...boxes.map((box) => box.y)),
    x2: Math.max(...boxes.map((box) => box.x + box.width)),
    y2: Math.max(...boxes.map((box) => box.y + box.height)),
  }
}

export function buildBlockPage(page: FileGraph, sources: Map<string, string[]>): BlockPage {
  const lines = sources.get(page.file) ?? []
  const { blocks, blockOfNode } = cutFile(page, lines)
  const { foreign, links, callers } = linkBlocks(page, blocks, blockOfNode, sources)
  const sizeWith = (limit: number) => {
    const placed = [...blocks, ...foreign, ...layOut(blocks, foreign, callers, links, limit)]
    const { x1, y1, x2, y2 } = boundsOf(placed)
    return Math.max((x2 - x1) / FRAME.width, (y2 - y1) / FRAME.height)
  }
  const best = COLUMN_LIMITS.reduce((chosen, limit) => (sizeWith(limit) < sizeWith(chosen) ? limit : chosen))
  const cards = layOut(blocks, foreign, callers, links, best)

  let top = 0
  for (const block of blocks) {
    block.stackY = top
    top += block.height
  }
  const all = [...blocks, ...foreign]
  const placed = [...all, ...cards]
  return {
    blocks: all,
    cards,
    frames: classFrames(blocks),
    arrows: [...links.map(toArrow), ...cardArrows(cards, blocks)],
    stackBounds: boundsOf(blocks.map((block) => ({ x: 0, y: block.stackY, width: block.width, height: block.height }))),
    bounds: boundsOf(placed),
  }
}
