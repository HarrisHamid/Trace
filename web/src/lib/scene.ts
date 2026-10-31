import { cssVar } from '@/lib/css'
import type { GraphNode } from '@/lib/run'
import type { Graph } from '@/types/contracts/graph.schema'

// What the map is made of, worked out once from the graph: one plate per module, a colour per module, and the belts.
// Everything is in model units (the baked layout's units); drawing scales it by the camera zoom.

export interface Point {
  x: number
  y: number
}

export interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface Plate {
  id: string
  name: string
  caption: string | null
  colour: string
  box: Box
  tab: Box
  external: boolean
  members: string[]
}

export interface Belt {
  from: string
  to: string
  colour: string
  length: number
}

export interface Reach {
  calls: number
  calledBy: number
}

export interface Scene {
  plates: Plate[]
  plateById: Map<string, Plate>
  plateIdOf: Map<string, string>
  bounds: Box
  positions: Map<string, Point>
  belts: Belt[]
  reach: Map<string, Reach>
  colourOf: (node: GraphNode) => string
}

export const EXTERNAL_PLATE = '__external__'
export const PLATE_DEPTH = 10

const MODULE_COLOURS = 6
const PAD = { x: 110, top: 92, bottom: 70 }
const TAB = { height: 30, left: 22, top: 16, base: 44, perChar: 9.2 }
const BELT_EDGES = new Set(['calls', 'routes_to'])
const REACH_EDGES = new Set(['calls', 'routes_to', 'uncertain'])

export function tabCentre(plate: Plate): Point {
  return { x: (plate.tab.x1 + plate.tab.x2) / 2, y: (plate.tab.y1 + plate.tab.y2) / 2 }
}

function makePlate(
  id: string,
  name: string,
  caption: string | null,
  colour: string,
  external: boolean,
  members: GraphNode[],
): Plate {
  const xs = members.map((node) => node.x ?? 0)
  const ys = members.map((node) => node.y ?? 0)
  const tabWidth = TAB.base + TAB.perChar * name.length
  const x1 = Math.min(...xs) - PAD.x
  const y1 = Math.min(...ys) - PAD.top
  const x2 = Math.max(Math.max(...xs) + PAD.x, x1 + tabWidth + TAB.left * 2)
  const y2 = Math.max(...ys) + PAD.bottom
  const tab = {
    x1: x1 + TAB.left,
    y1: y1 + TAB.top,
    x2: x1 + TAB.left + tabWidth,
    y2: y1 + TAB.top + TAB.height,
  }
  return { id, name, caption, colour, box: { x1, y1, x2, y2 }, tab, external, members: members.map((node) => node.id) }
}

export function buildScene(graph: Graph): Scene {
  const grey = cssVar('--star-external')
  const modules = graph.nodes.filter((node) => node.type === 'module').sort((a, b) => a.id.localeCompare(b.id))
  const colourByModule = new Map(
    modules.map((module, index) => [module.id, cssVar(`--module-${(index % MODULE_COLOURS) + 1}`)]),
  )
  const colourOf = (node: GraphNode) =>
    node.type === 'external' ? grey : (colourByModule.get(node.module) ?? grey)

  const plates: Plate[] = []
  for (const module of modules) {
    const members = graph.nodes.filter((node) => node.module === module.id && node.type !== 'module')
    if (members.length === 0) continue
    plates.push(
      makePlate(module.id, module.name, module.docstring ?? null, colourByModule.get(module.id)!, false, members),
    )
  }
  const externals = graph.nodes.filter((node) => node.type === 'external')
  if (externals.length > 0) {
    plates.push(makePlate(EXTERNAL_PLATE, 'outside', 'Libraries the code calls', grey, true, externals))
  }

  const plateById = new Map(plates.map((plate) => [plate.id, plate]))
  const plateIdOf = new Map<string, string>()
  for (const plate of plates) for (const id of plate.members) plateIdOf.set(id, plate.id)

  const positions = new Map<string, Point>()
  for (const node of graph.nodes) {
    const plate = node.type === 'module' ? plateById.get(node.id) : undefined
    positions.set(node.id, plate ? tabCentre(plate) : { x: node.x ?? 0, y: node.y ?? 0 })
    if (plate) plateIdOf.set(node.id, plate.id)
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const belts: Belt[] = []
  const reach = new Map<string, Reach>()
  const count = (id: string, key: keyof Reach) => {
    const entry = reach.get(id) ?? { calls: 0, calledBy: 0 }
    entry[key] += 1
    reach.set(id, entry)
  }
  for (const edge of graph.edges) {
    const from = positions.get(edge.source)
    const to = positions.get(edge.target)
    const source = nodesById.get(edge.source)
    if (!from || !to || !source) continue
    if (REACH_EDGES.has(edge.type)) {
      count(edge.source, 'calls')
      count(edge.target, 'calledBy')
    }
    if (BELT_EDGES.has(edge.type)) {
      belts.push({ from: edge.source, to: edge.target, colour: colourOf(source), length: Math.hypot(to.x - from.x, to.y - from.y) })
    }
  }

  const boxes = plates.map((plate) => plate.box)
  const bounds = {
    x1: Math.min(...boxes.map((box) => box.x1)),
    y1: Math.min(...boxes.map((box) => box.y1)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2)) + PLATE_DEPTH,
  }
  return { plates, plateById, plateIdOf, bounds, positions, belts, reach, colourOf }
}
