import type { Graph } from '../types/contracts/graph.schema'

// One file and everything one hop across its boundary, cut straight from the graph, so every id still means the same thing.
// No value imports from '@/': `make test-web` runs this file directly under node.

type GraphNode = Graph['nodes'][number]
type GraphEdge = Graph['edges'][number]

export const EXTERNAL_FILE = '<external>'

// Imports are left out because they repeat the same links at file level.
const SHOWN_EDGES = new Set<GraphEdge['type']>(['calls', 'routes_to', 'injects', 'inherits', 'implements', 'uncertain'])
const CALL_EDGES = new Set<GraphEdge['type']>(['calls', 'uncertain'])

export interface FileSummary {
  members: string
  internal: number
  inbound: number
  inboundFiles: number
  outbound: number
  outboundFiles: number
  outside: number
  repoCalls: number
  repoCallsResolved: number
}

export interface FileGraph {
  file: string
  module: GraphNode
  graph: Graph
  summary: FileSummary
  // False for an empty file: there is no code to cut into blocks.
  hasCanvas: boolean
}

function pluralise(count: number, word: string) {
  if (count === 1) return `1 ${word}`
  if (word === 'class') return `${count} classes`
  if (word === 'dependency') return `${count} dependencies`
  return `${count} ${word}s`
}

function describeMembers(nodes: GraphNode[]) {
  const order: GraphNode['type'][] = ['route', 'class', 'function', 'dependency']
  const parts = order.flatMap((type) => {
    const count = nodes.filter((node) => node.type === type).length
    return count > 0 ? [pluralise(count, type)] : []
  })
  return parts.join(', ') || 'no members'
}

export function fileList(graph: Graph) {
  return graph.nodes.filter((node) => node.type === 'module').map((node) => node.file)
}

export function buildFileGraph(graph: Graph, file: string): FileGraph | null {
  const module = graph.nodes.find((node) => node.type === 'module' && node.file === file)
  if (!module) return null

  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const own = graph.nodes.filter((node) => node.file === file)
  const ownIds = new Set(own.map((node) => node.id))
  const members = own.filter((node) => node.type !== 'module')

  const edges = graph.edges.filter((edge) => {
    if (!SHOWN_EDGES.has(edge.type)) return false
    return ownIds.has(edge.source) || ownIds.has(edge.target)
  })

  const incoming = edges.filter((edge) => !ownIds.has(edge.source))
  const outgoing = edges.filter((edge) => !ownIds.has(edge.target))
  const internal = edges.filter((edge) => ownIds.has(edge.source) && ownIds.has(edge.target))
  const toRepo = outgoing.filter((edge) => byId.get(edge.target)!.type !== 'external')
  const toOutside = outgoing.filter((edge) => byId.get(edge.target)!.type === 'external')
  const repoCalls = [...internal, ...toRepo].filter((edge) => CALL_EDGES.has(edge.type))

  const boundaryIds = new Set([...incoming.map((edge) => edge.source), ...outgoing.map((edge) => edge.target)])
  const boundary = [...boundaryIds].map((id) => byId.get(id)!)

  return {
    file,
    module,
    graph: { ...graph, nodes: [...own, ...boundary], edges },
    hasCanvas: module.line_end > 1,
    summary: {
      members: describeMembers(members),
      internal: internal.length,
      inbound: incoming.length,
      inboundFiles: new Set(incoming.map((edge) => byId.get(edge.source)!.file)).size,
      outbound: toRepo.length,
      outboundFiles: new Set(toRepo.map((edge) => byId.get(edge.target)!.file)).size,
      outside: toOutside.length,
      repoCalls: repoCalls.length,
      repoCallsResolved: repoCalls.filter((edge) => edge.resolved).length,
    },
  }
}

export function summaryLine({ members, internal, inbound, inboundFiles, outbound, outboundFiles, outside }: FileSummary) {
  const files = (count: number) => pluralise(count, 'file')
  return [
    members,
    `${internal} internal`,
    `${inbound} in from ${files(inboundFiles)}`,
    `${outbound} out to ${files(outboundFiles)}`,
    `${outside} outside`,
  ].join(' · ')
}

// Never a bare percentage: the count says what was checked.
export function footerLine({ repoCalls, repoCallsResolved, outside }: FileSummary) {
  const calls = repoCalls > 0 ? `${repoCallsResolved}/${repoCalls} repo calls resolved` : 'no repo calls'
  return `${calls} · ${outside} outside, by rule`
}
