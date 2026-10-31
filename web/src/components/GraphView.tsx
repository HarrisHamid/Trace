import cytoscape from 'cytoscape'
import { useEffect, useRef } from 'react'

import { useTraceStore } from '@/store'
import type { Graph } from '@/types/contracts/graph.schema'

const NODE_COLORS: Record<Graph['nodes'][number]['type'], string> = {
  module: '#6366f1',
  class: '#22c55e',
  function: '#38bdf8',
  route: '#f97316',
  dependency: '#eab308',
  external: '#737373',
}

function toElements(graph: Graph): cytoscape.ElementDefinition[] {
  const nodes = graph.nodes.map((node) => ({
    data: { id: node.id, label: node.name, color: NODE_COLORS[node.type] },
    position: { x: node.x ?? 0, y: node.y ?? 0 },
  }))
  const edges = graph.edges.map((edge, index) => ({
    data: { id: `edge-${index}`, source: edge.source, target: edge.target, type: edge.type },
  }))
  return [...nodes, ...edges]
}

export function GraphView({ graph }: { graph: Graph }) {
  const container = useRef<HTMLDivElement>(null)
  const selectNode = useTraceStore((state) => state.selectNode)

  useEffect(() => {
    const cy = cytoscape({
      container: container.current,
      elements: toElements(graph),
      layout: { name: 'preset', fit: true, padding: 48 },
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: 'data(label)',
            color: '#e5e5e5',
            'font-size': 12,
            'text-valign': 'bottom',
            'text-margin-y': 6,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': '#525252',
            'target-arrow-color': '#525252',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
          },
        },
        {
          selector: 'edge[type = "uncertain"]',
          style: { 'line-style': 'dashed', 'line-color': '#ef4444', 'target-arrow-color': '#ef4444' },
        },
      ],
    })
    cy.on('tap', 'node', (event) => selectNode(event.target.id()))
    return () => cy.destroy()
  }, [graph, selectNode])

  return <div ref={container} data-testid="graph" className="h-full w-full bg-neutral-950" />
}
