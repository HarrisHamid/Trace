import cytoscape from 'cytoscape'
import { motion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'

import { cssVar } from '@/lib/css'
import { bayer, type GraphNode, type RunView } from '@/lib/run'
import { tabCentre, type Box, type Scene } from '@/lib/scene'
import { Sky } from '@/lib/sky'
import { useTraceStore, type FocusRequest, type View } from '@/store'
import type { Graph } from '@/types/contracts/graph.schema'

const SERIF = '"Instrument Serif", Georgia, serif'
const MONO = '"JetBrains Mono Variable", monospace'
const INSETS = { top: 64, left: 44, bottom: 112 }
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
const FRAME_PADDING = 40
const LABEL_ROOM = 34
// Connections that explain how the code is wired rather than who calls whom. Hidden until asked for.
const WIRING = new Set(['imports', 'injects', 'inherits', 'implements'])

function toElements(graph: Graph, scene: Scene): cytoscape.ElementDefinition[] {
  const nodes = graph.nodes.map((node) => {
    const plate = node.type === 'module' ? scene.plateById.get(node.id) : undefined
    return {
      data: {
        id: node.id,
        name: node.name,
        type: node.type,
        module: node.module,
        colour: scene.colourOf(node),
        w: plate ? plate.tab.x2 - plate.tab.x1 : 20,
        h: plate ? plate.tab.y2 - plate.tab.y1 : 20,
      },
      position: plate ? tabCentre(plate) : { x: node.x ?? 0, y: node.y ?? 0 },
    }
  })
  const external = new Set(graph.nodes.filter((node) => node.type === 'external').map((node) => node.id))
  const edges = graph.edges.map((edge, index) => ({
    data: { id: `edge-${index}`, source: edge.source, target: edge.target, type: edge.type },
    classes: WIRING.has(edge.type) || external.has(edge.target) ? 'wiring' : '',
  }))
  return [...nodes, ...edges]
}

// Labels are drawn by the sky, so these styles are only the shapes. Fills take the colour of their module.
function stylesheet(reducedMotion: boolean): cytoscape.StylesheetJson {
  const gold = cssVar('--status-verified')
  const vermilion = cssVar('--status-unverified')
  const ice = cssVar('--status-gap')
  const belt = cssVar('--belt')
  const foreground = cssVar('--foreground')
  const background = cssVar('--background')
  const fade = reducedMotion ? 0 : 0.25
  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        width: 20,
        height: 20,
        'background-color': 'data(colour)',
        'border-width': 2.5,
        'border-color': background,
        opacity: 0.96,
        'transition-property': 'opacity, border-width',
        'transition-duration': fade,
      },
    },
    { selector: 'node[type = "route"]', style: { shape: 'star', width: 34, height: 34 } },
    { selector: 'node[type = "class"]', style: { shape: 'hexagon', width: 26, height: 26 } },
    { selector: 'node[type = "dependency"]', style: { shape: 'diamond', width: 24, height: 24 } },
    {
      selector: 'node[type = "external"]',
      style: { shape: 'ellipse', width: 18, height: 18, 'background-opacity': 0, 'border-width': 2.25, 'border-color': 'data(colour)' },
    },
    {
      selector: 'node[type = "unresolved"]',
      style: {
        shape: 'ellipse',
        width: 18,
        height: 18,
        'background-opacity': 0,
        'border-width': 2.25,
        'border-style': 'dashed',
        'border-color': ice,
      },
    },
    {
      selector: 'node[type = "module"]',
      style: { width: 'data(w)', height: 'data(h)', 'background-opacity': 0, 'border-width': 0 },
    },
    {
      selector: 'edge',
      style: {
        width: 3,
        'line-color': belt,
        'target-arrow-color': belt,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 1.05,
        'curve-style': 'straight',
        opacity: 0.78,
        'transition-property': 'opacity',
        'transition-duration': fade,
      },
    },
    { selector: 'edge.wiring', style: { display: 'none' } },
    {
      selector: 'edge.wiring.shown',
      style: { display: 'element', width: 1.5, 'line-style': 'dotted', 'target-arrow-shape': 'none', opacity: 0.4 },
    },
    {
      selector: 'edge[type = "uncertain"]',
      style: { 'line-style': 'dashed', 'line-color': ice, 'target-arrow-color': ice, opacity: 0.95 },
    },
    { selector: 'node.hovered', style: { 'border-color': foreground } },
    { selector: 'node.lit', style: { opacity: 1, 'border-width': 3.5, 'border-color': gold } },
    { selector: 'node.current', style: { 'border-width': 5 } },
    { selector: 'node.unverified', style: { 'border-color': vermilion } },
    { selector: 'node.gap', style: { 'border-style': 'dashed', 'border-color': ice } },
    { selector: 'node.dimmed', style: { opacity: 0.3 } },
    { selector: 'edge.dimmed', style: { opacity: 0.08 } },
    {
      selector: 'node.chosen',
      style: { 'outline-width': 1.5, 'outline-color': foreground, 'outline-offset': 5, opacity: 1 },
    },
    { selector: '.out-of-focus', style: { opacity: 0.07 } },
  ]
}

interface Viewport {
  zoom: number
  pan: cytoscape.Position
}

function nodesBox(nodes: cytoscape.NodeCollection): Box {
  const box = nodes.boundingBox({ includeLabels: false })
  return { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 + LABEL_ROOM }
}

function fitBox(cy: cytoscape.Core, box: Box, rightInset: number): Viewport {
  const width = cy.width() - INSETS.left - rightInset
  const height = cy.height() - INSETS.top - INSETS.bottom
  const boxWidth = box.x2 - box.x1 + FRAME_PADDING * 2
  const boxHeight = box.y2 - box.y1 + FRAME_PADDING * 2
  const zoom = Math.min(width / boxWidth, height / boxHeight, MAX_FRAME_ZOOM)
  return {
    zoom,
    pan: {
      x: INSETS.left + width / 2 - ((box.x1 + box.x2) / 2) * zoom,
      y: INSETS.top + height / 2 - ((box.y1 + box.y2) / 2) * zoom,
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
  cy.scratch('moved', true)
  cy.stop(true, false)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) cy.viewport(viewport)
  else cy.animate({ ...viewport, duration, easing: 'ease-in-out-cubic' })
}

function moduleNodes(cy: cytoscape.Core, module: string) {
  return cy.nodes().filter((node) => node.data('module') === module)
}

interface GraphViewProps {
  graph: Graph
  scene: Scene
  run: RunView
  rightInset: number
}

export function GraphView({ graph, scene, run, rightInset }: GraphViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const backCanvas = useRef<HTMLCanvasElement>(null)
  const frontCanvas = useRef<HTMLCanvasElement>(null)
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
  const showWiring = useTraceStore((state) => state.showWiring)
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
      elements: toElements(graph, scene),
      layout: { name: 'preset' },
      style: stylesheet(reducedMotion),
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      boxSelectionEnabled: false,
      autoungrabify: true,
      autounselectify: true,
    })
    cy.viewport(fitBox(cy, scene.bounds, inset.current))
    const sky = new Sky(backCanvas.current!, frontCanvas.current!, cy, graph.nodes, scene)
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

    // Canvas text can't reflow, so labels are measured again once the web fonts arrive.
    Promise.all([document.fonts.load(`700 12px ${MONO}`), document.fonts.load(`11px ${MONO}`), document.fonts.load(`italic 26px ${SERIF}`)]).then(
      () => {
        if (!cy.destroyed()) sky.fontsReady()
      },
    )

    // The container is still settling on first paint, so the opening fit is redone until the camera has been moved.
    const resizing = new ResizeObserver(() => {
      cy.resize()
      if (!cy.scratch('moved')) cy.viewport(fitBox(cy, scene.bounds, inset.current))
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
  }, [graph, scene, openNode, clearSelection, enterModule])

  // Lit nodes, with their Bayer letters, the dimmed rest, and the belt behind them.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const active = run.phase !== 'idle'
    cy.batch(() => {
      cy.elements().removeClass('lit current unverified gap dimmed')
      if (active) cy.elements().addClass('dimmed')
      run.stars.forEach((star) => {
        const node = cy.getElementById(star.nodeId)
        node.removeClass('dimmed').addClass('lit')
        if (star.status === 'unverified' || star.status === 'gap') node.addClass(star.status)
        if (star.nodeId === run.current) node.addClass('current')
      })
    })
    skyRef.current?.setRun({
      walked: run.walked,
      segments: run.segments,
      revealed: run.revealed,
      lit: run.stars.map((star, index) => ({ id: star.nodeId, status: star.status, letter: bayer(index) })),
      current: run.current,
      active,
    })
  }, [run])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.edges('.wiring')[showWiring ? 'addClass' : 'removeClass']('shown')
    skyRef.current?.draw()
  }, [showWiring, graph, scene])

  // The camera follows the walk, then pulls back to show the whole answer.
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
    fly(cy, fitBox(cy, nodesBox(path), inset.current), REVEAL_CAMERA_MS)
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
        if (view.module !== null) cy.elements().difference(inside).difference(inside.edgesWith(inside)).addClass('out-of-focus')
      })
      sky.setFocusModule(view.module)
    }

    const plate = view.module === null ? undefined : scene.plateById.get(view.module)
    const box = view.module === null ? scene.bounds : (plate?.box ?? nodesBox(moduleNodes(cy, view.module)))
    const frame = fitBox(cy, box, inset.current)
    if (focusChanged && focusRequest) {
      const position = cy.getElementById(focusRequest.nodeId).position()
      const zoom = viewChanged ? frame.zoom : Math.max(cy.zoom(), FOCUS_ZOOM)
      fly(cy, centredOn(cy, position, zoom, inset.current), viewChanged ? ZOOM_MS : CAMERA_MS)
    } else if (viewChanged) {
      fly(cy, frame, ZOOM_MS)
    }
  }, [view, focusRequest, scene])

  // Selection ring. A node hidden behind the panel that just opened is brought back into view.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.nodes().removeClass('chosen')
    skyRef.current?.setSelected(selectedNode)
    if (!selectedNode) return
    const node = cy.getElementById(selectedNode)
    node.addClass('chosen')
    if (node.renderedPosition().x > cy.width() - rightInset - FRAME_PADDING) {
      fly(cy, centredOn(cy, node.position(), cy.zoom(), rightInset), CAMERA_MS)
    }
  }, [selectedNode, rightInset])

  // The explanation sits beside the node, and follows it as the camera moves.
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
      <canvas ref={backCanvas} className="absolute inset-0 h-full w-full" />
      {/* Cytoscape forces position: relative on its container, so the wrapper does the absolute positioning. */}
      <div className="absolute inset-0">
        <div ref={container} data-testid="graph" className="h-full w-full" />
      </div>
      <canvas ref={frontCanvas} className="pointer-events-none absolute inset-0 h-full w-full" />
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
            className="-translate-y-full bg-background/80 px-2.5 py-1.5"
          >
            <p className="kicker text-primary">{captionName}</p>
            <p className="mt-0.5 font-serif text-lg leading-snug text-foreground italic">{run.caption}</p>
          </motion.div>
        )}
      </div>
    </>
  )
}
