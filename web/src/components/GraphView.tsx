import cytoscape from 'cytoscape'
import { motion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'

import { bayer, type GraphNode, type RunView } from '@/lib/run'
import { cssVar, Sky } from '@/lib/sky'
import { useTraceStore, type FocusRequest, type View } from '@/store'
import type { Graph } from '@/types/contracts/graph.schema'

const SERIF = '"Instrument Serif", Georgia, serif'
const MONO = '"JetBrains Mono Variable", monospace'
const INSETS = { top: 72, left: 44, bottom: 124 }
const FOCUS_ZOOM = 1.15
const MAX_FRAME_ZOOM = 1.5
const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5
const CAMERA_MS = 380
const REVEAL_CAMERA_MS = 520
const ZOOM_MS = 650
// Long enough for cytoscape to report a double tap on a module before its single tap opens the code panel.
const DOUBLE_TAP_MS = 300
const CAPTION_WIDTH = 280
const CAPTION_GAP = 22
const FRAME_PADDING = 50

// Spaced capitals, like a constellation name on an atlas plate.
function moduleLabel(name: string) {
  return name.toUpperCase().split('').join(' ')
}

function toElements(graph: Graph): cytoscape.ElementDefinition[] {
  const nodes = graph.nodes.map((node) => ({
    data: {
      id: node.id,
      name: node.name,
      label: node.type === 'module' ? moduleLabel(node.name) : node.name,
      type: node.type,
      module: node.module,
      colour: cssVar(`--star-${node.type}`),
    },
    position: { x: node.x ?? 0, y: node.y ?? 0 },
  }))
  const edges = graph.edges.map((edge, index) => ({
    data: { id: `edge-${index}`, source: edge.source, target: edge.target, type: edge.type },
  }))
  return [...nodes, ...edges]
}

function stylesheet(reducedMotion: boolean): cytoscape.StylesheetJson {
  const gold = cssVar('--status-verified')
  const vermilion = cssVar('--status-unverified')
  const ice = cssVar('--status-gap')
  const edge = cssVar('--star-edge')
  const foreground = cssVar('--foreground')
  const background = cssVar('--background')
  return [
    {
      selector: 'node',
      style: {
        width: 9,
        height: 9,
        'background-color': 'data(colour)',
        'border-width': 0,
        opacity: 0.68,
        label: 'data(label)',
        color: foreground,
        'font-family': MONO,
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 6,
        'min-zoomed-font-size': 10,
        'text-background-color': background,
        'text-background-opacity': 0.55,
        'text-background-padding': '2px',
        'transition-property': 'opacity, width, height, border-width',
        'transition-duration': reducedMotion ? 0 : 0.25,
      },
    },
    { selector: 'node[type = "route"]', style: { shape: 'star', width: 20, height: 20, opacity: 0.85 } },
    { selector: 'node[type = "class"]', style: { shape: 'hexagon', width: 14, height: 14 } },
    { selector: 'node[type = "dependency"]', style: { shape: 'diamond', width: 13, height: 13 } },
    {
      selector: 'node[type = "external"]',
      style: { 'background-opacity': 0, 'border-width': 1.25, 'border-color': 'data(colour)' },
    },
    {
      selector: 'node[type = "module"]',
      style: {
        width: 30,
        height: 30,
        'background-opacity': 0,
        opacity: 0.8,
        color: 'data(colour)',
        'font-family': SERIF,
        'font-style': 'italic',
        'font-size': 26,
        'text-valign': 'center',
        'text-margin-y': 0,
        'text-background-opacity': 0,
        'min-zoomed-font-size': 0,
        'text-events': 'yes',
      },
    },
    {
      selector: 'edge',
      style: {
        width: 0.8,
        'line-color': edge,
        'target-arrow-color': edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.55,
        'curve-style': 'straight',
        opacity: 0.22,
        'transition-property': 'opacity',
        'transition-duration': reducedMotion ? 0 : 0.25,
      },
    },
    {
      selector: 'edge[type = "imports"]',
      style: { 'line-style': 'dotted', 'target-arrow-shape': 'none', opacity: 0.1 },
    },
    { selector: 'edge[type = "injects"]', style: { 'line-style': 'dotted' } },
    {
      selector: 'edge[type = "uncertain"]',
      style: { 'line-style': 'dashed', 'line-color': ice, 'target-arrow-color': ice, opacity: 0.75, width: 1.2 },
    },
    { selector: 'node.in-focus', style: { opacity: 0.95, 'min-zoomed-font-size': 0 } },
    { selector: 'node.hovered', style: { opacity: 1, 'min-zoomed-font-size': 0 } },
    {
      selector: 'node.lit',
      style: {
        width: 15,
        height: 15,
        opacity: 1,
        color: gold,
        'font-size': 14,
        'min-zoomed-font-size': 0,
      },
    },
    { selector: 'node.lit[type = "route"]', style: { width: 24, height: 24 } },
    {
      selector: 'node.unverified',
      style: { 'background-opacity': 0, 'border-width': 2.5, 'border-color': vermilion, color: vermilion },
    },
    {
      selector: 'node.gap',
      style: {
        'background-opacity': 0,
        'border-width': 2.5,
        'border-style': 'dashed',
        'border-color': ice,
        color: ice,
      },
    },
    { selector: 'node.current', style: { width: 19, height: 19 } },
    {
      selector: 'node.chosen',
      style: {
        'outline-width': 1.25,
        'outline-color': foreground,
        'outline-offset': 5,
        opacity: 1,
        'min-zoomed-font-size': 0,
      },
    },
    { selector: '.out-of-focus', style: { opacity: 0.07 } },
  ]
}

interface Viewport {
  zoom: number
  pan: cytoscape.Position
}

function framed(cy: cytoscape.Core, nodes: cytoscape.NodeCollection, rightInset: number): Viewport {
  const box = nodes.boundingBox({ includeLabels: false })
  const width = cy.width() - INSETS.left - rightInset
  const height = cy.height() - INSETS.top - INSETS.bottom
  const boxWidth = box.w + FRAME_PADDING * 2
  const boxHeight = box.h + FRAME_PADDING * 2
  const zoom = Math.min(width / boxWidth, height / boxHeight, MAX_FRAME_ZOOM)
  return {
    zoom,
    pan: {
      x: INSETS.left + width / 2 - (box.x1 + box.w / 2) * zoom,
      y: INSETS.top + height / 2 - (box.y1 + box.h / 2) * zoom,
    },
  }
}

function centredOn(cy: cytoscape.Core, position: cytoscape.Position, zoom: number, rightInset: number): Viewport {
  const width = cy.width() - INSETS.left - rightInset
  const height = cy.height() - INSETS.top - INSETS.bottom
  return {
    zoom,
    pan: { x: INSETS.left + width / 2 - position.x * zoom, y: INSETS.top + height / 2 - position.y * zoom },
  }
}

function fly(cy: cytoscape.Core, viewport: Viewport, duration: number) {
  cy.stop(true, false)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) cy.viewport(viewport)
  else cy.animate({ ...viewport, duration, easing: 'ease-in-out-cubic' })
}

function moduleNodes(cy: cytoscape.Core, module: string) {
  return cy.nodes().filter((node) => node.data('module') === module)
}

interface GraphViewProps {
  graph: Graph
  run: RunView
  rightInset: number
}

export function GraphView({ graph, run, rightInset }: GraphViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const cyRef = useRef<cytoscape.Core | null>(null)
  const skyRef = useRef<Sky | null>(null)
  const inset = useRef(rightInset)
  const lastView = useRef<View | null>(null)
  const lastFocus = useRef<FocusRequest | null>(null)
  const openNode = useTraceStore((state) => state.openNode)
  const clearSelection = useTraceStore((state) => state.clearSelection)
  const enterModule = useTraceStore((state) => state.enterModule)
  const selectedNode = useTraceStore((state) => state.selectedNode)
  const view = useTraceStore((state) => state.view)
  const focusRequest = useTraceStore((state) => state.focusRequest)
  const nodesById = useMemo(() => new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node])), [graph])

  useEffect(() => {
    inset.current = rightInset
  }, [rightInset])

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cy = cytoscape({
      container: container.current,
      elements: toElements(graph),
      layout: { name: 'preset' },
      style: stylesheet(reducedMotion),
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      boxSelectionEnabled: false,
      autoungrabify: true,
      autounselectify: true,
    })
    cy.viewport(framed(cy, cy.nodes(), inset.current))
    const sky = new Sky(canvas.current!, cy, graph.nodes)
    cyRef.current = cy
    skyRef.current = sky

    let pendingTap = 0
    cy.on('tap', 'node', (event) => {
      const id: string = event.target.id()
      window.clearTimeout(pendingTap)
      if (event.target.data('type') === 'module') {
        pendingTap = window.setTimeout(() => openNode(id), DOUBLE_TAP_MS)
      } else {
        openNode(id)
      }
    })
    cy.on('dbltap', 'node[type = "module"]', (event) => {
      window.clearTimeout(pendingTap)
      enterModule(event.target.id())
    })
    cy.on('tap', (event) => {
      if (event.target === cy) clearSelection()
    })
    cy.on('mouseover', 'node', (event) => {
      event.target.addClass('hovered')
      if (event.target.data('type') !== 'module') sky.setHover(event.target.id())
      container.current!.style.cursor = 'pointer'
    })
    cy.on('mouseout', 'node', (event) => {
      event.target.removeClass('hovered')
      sky.setHover(null)
      container.current!.style.cursor = ''
    })
    // No mouseout fires when the camera moves a star out from under a still cursor.
    cy.on('viewport', () => {
      cy.nodes('.hovered').removeClass('hovered')
      sky.setHover(null)
    })
    cy.on('render', () => sky.draw())

    // Canvas text can't reflow, so labels are restyled once the web fonts arrive.
    Promise.all([document.fonts.load(`italic 26px ${SERIF}`), document.fonts.load(`11px ${MONO}`)]).then(() => {
      if (!cy.destroyed()) cy.style().update()
    })

    const resizing = new ResizeObserver(() => {
      cy.resize()
      sky.resize()
    })
    resizing.observe(container.current!)

    return () => {
      window.clearTimeout(pendingTap)
      resizing.disconnect()
      sky.destroy()
      cy.destroy()
      cyRef.current = null
      skyRef.current = null
      lastView.current = null
      lastFocus.current = null
    }
  }, [graph, openNode, clearSelection, enterModule])

  // Lit stars, with their Bayer letters, and the thread behind them.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.batch(() => {
      cy.nodes().removeClass('lit current unverified gap')
      cy.nodes().forEach((node) => {
        if (node.data('type') !== 'module') node.data('label', node.data('name'))
      })
      run.stars.forEach((star, index) => {
        const node = cy.getElementById(star.nodeId)
        node.addClass('lit')
        if (star.status === 'unverified' || star.status === 'gap') node.addClass(star.status)
        if (star.nodeId === run.current) node.addClass('current')
        node.data('label', `${bayer(index)}  ${node.data('name')}`)
      })
    })
    skyRef.current?.setRun({
      walked: run.walked,
      segments: run.segments,
      revealed: run.revealed,
      lit: run.stars.map((star) => ({ id: star.nodeId, status: star.status })),
      current: run.current,
    })
  }, [run])

  // The camera follows the walk, then pulls back to show the whole constellation.
  const { phase, current } = run
  useEffect(() => {
    const cy = cyRef.current
    if (!cy || phase !== 'walking' || !current) return
    fly(cy, centredOn(cy, cy.getElementById(current).position(), FOCUS_ZOOM, inset.current), CAMERA_MS)
  }, [phase, current])

  const pathKey = run.segments.map((segment) => segment.to).join('|')
  const firstStep = run.segments[0]?.from
  useEffect(() => {
    const cy = cyRef.current
    if (!cy || phase !== 'revealing' || !firstStep) return
    const ids = [firstStep, ...pathKey.split('|')]
    const path = cy.nodes().filter((node) => ids.includes(node.id()))
    fly(cy, framed(cy, path, inset.current), REVEAL_CAMERA_MS)
  }, [phase, firstStep, pathKey])

  // View changes and focus requests share one effect so a palette jump into another module is a single camera move.
  useEffect(() => {
    const cy = cyRef.current
    const sky = skyRef.current
    if (!cy || !sky) return
    const viewChanged = lastView.current !== view
    const focusChanged = lastFocus.current !== focusRequest
    const firstRun = lastView.current === null
    lastView.current = view
    lastFocus.current = focusRequest
    if (firstRun) return

    if (viewChanged) {
      const inside = view.module === null ? cy.collection() : moduleNodes(cy, view.module)
      cy.batch(() => {
        cy.elements().removeClass('out-of-focus')
        cy.nodes().removeClass('in-focus')
        if (view.module !== null) {
          inside.addClass('in-focus')
          cy.elements().difference(inside).difference(inside.edgesWith(inside)).addClass('out-of-focus')
        }
      })
      sky.setFocusModule(view.module)
    }

    const frame = framed(cy, view.module === null ? cy.nodes() : moduleNodes(cy, view.module), inset.current)
    if (focusChanged && focusRequest) {
      const position = cy.getElementById(focusRequest.nodeId).position()
      const zoom = viewChanged ? frame.zoom : Math.max(cy.zoom(), FOCUS_ZOOM)
      fly(cy, centredOn(cy, position, zoom, inset.current), viewChanged ? ZOOM_MS : CAMERA_MS)
    } else if (viewChanged) {
      fly(cy, frame, ZOOM_MS)
    }
  }, [view, focusRequest])

  // Selection ring. A node hidden behind the panel that just opened is brought back into view.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.nodes().removeClass('chosen')
    if (!selectedNode) return
    const node = cy.getElementById(selectedNode)
    node.addClass('chosen')
    if (node.renderedPosition().x > cy.width() - rightInset - FRAME_PADDING) {
      fly(cy, centredOn(cy, node.position(), cy.zoom(), rightInset), CAMERA_MS)
    }
  }, [selectedNode, rightInset])

  // The explanation sits beside the star, and follows it as the camera moves.
  const captionNode = run.caption ? run.current : null
  useEffect(() => {
    const cy = cyRef.current
    const element = anchor.current
    if (!cy || !element) return
    const place = () => {
      if (!captionNode) return
      const { x, y } = cy.getElementById(captionNode).renderedPosition()
      const flip = x + CAPTION_GAP + CAPTION_WIDTH > cy.width() - inset.current
      const left = flip ? x - CAPTION_GAP - CAPTION_WIDTH : x + CAPTION_GAP
      element.style.transform = `translate(${left}px, ${y - CAPTION_GAP}px)`
      element.style.textAlign = flip ? 'right' : 'left'
    }
    place()
    cy.on('viewport', place)
    return () => {
      cy.off('viewport', place)
    }
  }, [captionNode])

  const captionName = captionNode ? nodesById.get(captionNode)?.name : null

  return (
    <>
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      {/* Cytoscape forces position: relative on its container, so the wrapper does the absolute positioning. */}
      <div className="absolute inset-0">
        <div ref={container} data-testid="graph" className="h-full w-full" />
      </div>
      <div
        ref={anchor}
        className="pointer-events-none absolute top-0 left-0"
        style={{ width: CAPTION_WIDTH }}
        aria-hidden
      >
        {captionNode && (
          <motion.div
            key={captionNode}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="-translate-y-full bg-background/75 px-2.5 py-1.5"
          >
            <p className="kicker text-primary">{captionName}</p>
            <p className="mt-0.5 font-serif text-lg leading-snug text-foreground italic">{run.caption}</p>
          </motion.div>
        )}
      </div>
    </>
  )
}
