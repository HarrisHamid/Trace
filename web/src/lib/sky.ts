import type { Core } from 'cytoscape'

import { distanceToRoute, drawLine, pointAlong, traceRoute } from '@/lib/belt'
import { cssVar } from '@/lib/css'
import { isInside } from '@/lib/filegraph'
import { LabelPainter, type Frame, type LitStar } from '@/lib/pills'
import { STEP_MS, type GraphNode, type Segment, type StarStatus } from '@/lib/run'
import type { Route } from '@/lib/belt'
import { labelEnd, type Belt, type Box, type Plate, type Point, type Scene } from '@/lib/scene'
import type { PinnedLine } from '@/store'

// Everything Cytoscape can't draw. Two canvases sandwich it: behind, the dot grid, the module boxes, the call lines and
// the answer's path; in front, the label cards and the marker that travels along the answer.

const GRID_STEP = 24
const MIN_GRID_PIXELS = 10
const OUTLINE_PADDING = 34
const PLATE_RADIUS = 8
const DIMMED_PLATE = 0.55
const BACKGROUND_PLATE = 0.22
const DIMMED_BELT = 0.16
const BACKGROUND_BELT = 0.07
const PINNED_ASIDE = 0.12
const LINE_REACH_PIXELS = 8
const PATH_WIDTH = 3.5
const MIN_PATH_WIDTH = 2
const ARROW_SIZE = 6
const CURRENT_RING = 15

export interface SkyRun {
  walked: string[]
  segments: Segment[]
  revealed: number
  lit: { id: string; status: StarStatus; letter: string }[]
  current: string | null
  active: boolean
}

const EMPTY_RUN: SkyRun = { walked: [], segments: [], revealed: 0, lit: [], current: null, active: false }

interface Parcel {
  x: number
  y: number
}


export class Sky {
  private readonly backCanvas: HTMLCanvasElement
  private readonly frontCanvas: HTMLCanvasElement
  private readonly back: CanvasRenderingContext2D
  private readonly front: CanvasRenderingContext2D
  private readonly cy: Core
  private readonly nodes: GraphNode[]
  private readonly scene: Scene
  private readonly painter: LabelPainter
  private readonly pathColour = cssVar('--path')
  private readonly gapColour = cssVar('--status-gap')
  private readonly background = cssVar('--background')
  private readonly plateFill = cssVar('--card')
  private readonly plateBorder = cssVar('--border')
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly nodeModule = new Map<string, string>()
  private run = EMPTY_RUN
  private litPlates = new Set<string>()
  private lit = new Map<string, LitStar>()
  private progress = 0
  private hover: string | null = null
  private selected: string | null = null
  private focusModule: string | null = null
  private allConnections = false
  private callLines = false
  private pin: PinnedLine | null = null
  private spot: string | null = null
  private near: Set<string> | null = null
  private paused = false
  private outlines: Box[] = []
  private parcel: Parcel | null = null
  private width = 0
  private height = 0
  private frame = 0
  private lastTick = 0

  constructor(back: HTMLCanvasElement, front: HTMLCanvasElement, cy: Core, nodes: GraphNode[], scene: Scene) {
    this.backCanvas = back
    this.frontCanvas = front
    this.back = back.getContext('2d')!
    this.front = front.getContext('2d')!
    this.cy = cy
    this.nodes = nodes
    this.scene = scene
    this.painter = new LabelPainter(nodes, scene)
    for (const node of nodes) this.nodeModule.set(node.id, node.module)
    this.resize()
    this.schedule()
  }

  resize() {
    const scale = window.devicePixelRatio || 1
    const { width, height } = this.backCanvas.getBoundingClientRect()
    this.width = width
    this.height = height
    for (const canvas of [this.backCanvas, this.frontCanvas]) {
      canvas.width = width * scale
      canvas.height = height * scale
    }
    this.back.setTransform(scale, 0, 0, scale, 0, 0)
    this.front.setTransform(scale, 0, 0, scale, 0, 0)
    this.draw()
  }

  // Labels measured before the web fonts arrived are wrong.
  fontsReady() {
    this.painter.reset()
    this.draw()
  }

  setRun(run: SkyRun) {
    const redrawn = run.segments.some((segment, index) => segment.to !== this.run.segments[index]?.to)
    if (redrawn || run.segments.length === 0) this.progress = 0
    this.run = run
    this.lit = new Map(run.lit.map((star) => [star.id, { letter: star.letter, status: star.status }]))
    this.litPlates = new Set(run.lit.map((star) => this.scene.plateIdOf.get(star.id)).filter((id) => id !== undefined))
    this.schedule()
  }

  setHover(id: string | null) {
    if (id === this.hover) return
    this.hover = id
    this.spotlight()
  }

  setSelected(id: string | null) {
    this.selected = id
    this.spotlight()
  }

  setAllConnections(on: boolean) {
    this.allConnections = on
    this.schedule()
  }

  setCallLines(on: boolean) {
    this.callLines = on
    this.schedule()
  }

  setPinnedLine(line: PinnedLine | null) {
    this.pin = line
    this.spotlight()
  }

  // The line a click on the map lands on: the answer first, because it is drawn on top, then the nearest line on show.
  lineAt(point: Point): PinnedLine | null {
    const reach = LINE_REACH_PIXELS / this.cy.zoom()
    for (const [index, segment] of this.run.segments.entries()) {
      const route = this.scene.routeOf(segment.from, segment.to)
      if (index < this.progress && route && distanceToRoute(route, point) <= reach) {
        return { from: segment.from, to: segment.to }
      }
    }
    let nearest: PinnedLine | null = null
    let closest = reach
    for (const belt of this.scene.belts) {
      if (this.beltAlpha(belt) === 0) continue
      const distance = distanceToRoute(belt.route, point)
      if (distance <= closest) {
        closest = distance
        nearest = { from: belt.from, to: belt.to }
      }
    }
    return nearest
  }

  // A pinned line outranks everything. Otherwise the node under attention shows its own lines, and whatever they don't
  // reach steps back. A node with no lines changes nothing.
  private spotlight() {
    const { pin } = this
    const id = pin ? null : (this.hover ?? this.selected)
    const neighbours = id ? this.scene.neighbours.get(id) : undefined
    const near = pin ? new Set([pin.from, pin.to]) : id && neighbours ? new Set([id, ...neighbours]) : null
    this.spot = !pin && near ? id : null
    this.near = near
    this.cy.batch(() => {
      this.cy.nodes().removeClass('aside faded')
      if (near) this.cy.nodes('[type != "module"]').filter((node) => !near.has(node.id())).addClass(pin ? 'faded' : 'aside')
    })
    this.schedule()
  }

  private isPinned(from: string, to: string) {
    return this.pin?.from === from && this.pin.to === to
  }

  setFocusModule(module: string | null) {
    this.focusModule = module
    this.outlines = module === null ? [] : this.classOutlines(module)
    this.schedule()
  }

  // The map under a file's page stops drawing altogether.
  setPaused(paused: boolean) {
    if (paused === this.paused) return
    this.paused = paused
    if (paused) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    } else {
      this.lastTick = 0
      this.draw()
      this.schedule()
    }
  }

  destroy() {
    cancelAnimationFrame(this.frame)
  }

  private get target() {
    return Math.max(0, Math.min(this.run.revealed - 1, this.run.segments.length))
  }

  // Only the current step's ring moves, so the loop sleeps once the path is laid and the run is over.
  private get keepGoing() {
    if (this.progress < this.target) return true
    return !this.reducedMotion.matches && this.run.current !== null
  }

  private schedule() {
    if (!this.frame && !this.paused) this.frame = requestAnimationFrame(this.tick)
  }

  private tick = (now: number) => {
    this.frame = 0
    const elapsed = this.lastTick ? now - this.lastTick : 16
    this.lastTick = now
    this.progress = this.reducedMotion.matches ? this.target : Math.min(this.target, this.progress + elapsed / STEP_MS)
    this.draw(now)
    if (this.keepGoing) this.schedule()
    else this.lastTick = 0
  }

  draw = (now = performance.now()) => {
    if (this.paused) return
    const zoom = this.cy.zoom()
    const pan = this.cy.pan()
    const frame: Frame = { zoom, pan, now, width: this.width, height: this.height }
    this.drawBack(frame)
    this.drawFront(frame)
  }

  private pinnedPlate(plate: Plate) {
    return [this.pin?.from, this.pin?.to].some((id) => id !== undefined && this.scene.plateIdOf.get(id) === plate.id)
  }

  private outsideInUse(plate: Plate) {
    return this.litPlates.has(plate.id) || (this.selected !== null && this.scene.plateIdOf.get(this.selected) === plate.id)
  }

  private plateAlpha = (plate: Plate) => {
    if (plate.external && !this.allConnections && !this.outsideInUse(plate)) return 0
    let alpha = 1
    if (this.focusModule !== null && !isInside(plate.id, this.focusModule)) alpha = BACKGROUND_PLATE
    if (this.run.active && !this.litPlates.has(plate.id)) alpha *= DIMMED_PLATE
    if (this.pin && !this.pinnedPlate(plate)) alpha *= DIMMED_PLATE
    return alpha
  }

  private drawBack(frame: Frame) {
    const { zoom, pan, now } = frame
    this.back.fillStyle = this.background
    this.back.fillRect(0, 0, this.width, this.height)
    this.drawGrid(zoom, pan)
    this.drawPlates(zoom, pan)
    this.drawOutlines(zoom, pan)
    this.drawBelts(frame)
    this.drawWalk(frame)
    this.drawThread(frame)
    this.drawCurrent(zoom, pan, now)
  }

  private drawFront(frame: Frame) {
    const { front } = this
    front.clearRect(0, 0, this.width, this.height)
    const state = {
      lit: this.lit,
      active: this.run.active,
      hover: this.hover,
      selected: this.selected,
      focusModule: this.focusModule,
      near: this.near,
      pinned: this.pin !== null,
      showOutside: this.allConnections,
      plateAlpha: this.plateAlpha,
    }
    this.painter.drawPills(front, frame, state)
    this.painter.drawPlateLabels(front, frame, state)
    this.drawParcel(frame)
  }

  // A faint dot grid that moves with the map, so panning reads as movement. It drops out when zoomed far out.
  private drawGrid(zoom: number, pan: Point) {
    const step = GRID_STEP * zoom
    if (step < MIN_GRID_PIXELS) return
    const { back, width, height } = this
    back.save()
    back.fillStyle = 'rgba(230,232,235,0.06)'
    const startX = ((pan.x % step) + step) % step
    const startY = ((pan.y % step) + step) % step
    for (let x = startX; x < width; x += step) {
      for (let y = startY; y < height; y += step) back.fillRect(x - 0.5, y - 0.5, 1.2, 1.2)
    }
    back.restore()
  }

  // Each module is a flat box with a thin strip of its colour along the top edge.
  private drawPlates(zoom: number, pan: Point) {
    const { back } = this
    for (const plate of this.scene.plates) {
      const alpha = this.plateAlpha(plate)
      if (alpha === 0) continue
      const x = plate.box.x1 * zoom + pan.x
      const y = plate.box.y1 * zoom + pan.y
      const width = (plate.box.x2 - plate.box.x1) * zoom
      const height = (plate.box.y2 - plate.box.y1) * zoom
      const radius = PLATE_RADIUS * zoom
      if (x > this.width || y > this.height || x + width < 0 || y + height < 0) continue

      back.save()
      back.globalAlpha = alpha
      back.beginPath()
      back.roundRect(x, y, width, height, radius)
      back.fillStyle = this.plateFill
      back.fill()
      back.lineWidth = 1
      back.strokeStyle = this.plateBorder
      back.setLineDash(plate.external ? [6, 5] : [])
      back.stroke()
      back.setLineDash([])

      back.beginPath()
      back.roundRect(x, y, width, Math.max(2, 3 * zoom), [radius, radius, 0, 0])
      back.fillStyle = plate.colour
      back.globalAlpha = alpha * 0.85
      back.fill()
      back.restore()
    }
  }

  private classOutlines(module: string): Box[] {
    const classes = this.nodes.filter((node) => node.type === 'class' && isInside(node.module, module))
    const groups = classes.map((owner) => this.nodes.filter((node) => node.id === owner.id || node.id.startsWith(`${owner.id}.`)))
    // An outline groups a class with its methods, so a class with none has nothing to group.
    return groups.filter((members) => members.length > 1).map((members) => {
      const xs = members.map((node) => node.x ?? 0)
      const ys = members.map((node) => node.y ?? 0)
      return {
        x1: Math.min(...xs) - OUTLINE_PADDING,
        y1: Math.min(...ys) - OUTLINE_PADDING,
        x2: Math.max(...members.map(labelEnd)) + OUTLINE_PADDING / 2,
        y2: Math.max(...ys) + OUTLINE_PADDING + 16,
      }
    })
  }

  private drawOutlines(zoom: number, pan: Point) {
    const { back } = this
    back.save()
    back.strokeStyle = 'rgba(230,232,235,0.2)'
    back.lineWidth = 1
    back.setLineDash([5, 4])
    for (const box of this.outlines) {
      back.beginPath()
      back.roundRect(
        box.x1 * zoom + pan.x,
        box.y1 * zoom + pan.y,
        (box.x2 - box.x1) * zoom,
        (box.y2 - box.y1) * zoom,
        8 * zoom,
      )
      back.stroke()
    }
    back.restore()
  }

  private screen(id: string, zoom: number, pan: Point): Point | null {
    const point = this.scene.positions.get(id)
    return point ? { x: point.x * zoom + pan.x, y: point.y * zoom + pan.y } : null
  }

  private inFocus(...ids: string[]) {
    const focus = this.focusModule
    if (focus === null) return true
    return ids.some((id) => isInside(this.nodeModule.get(id) ?? '', focus))
  }

  // Zero means the line is not drawn at all: the map at rest shows only what happens inside each module.
  private beltAlpha(belt: Belt) {
    if (this.pin) return this.isPinned(belt.from, belt.to) ? 1 : this.restingBeltAlpha(belt) * PINNED_ASIDE
    return this.restingBeltAlpha(belt)
  }

  private restingBeltAlpha(belt: Belt) {
    if (this.spot) return belt.from === this.spot || belt.to === this.spot ? 1 : 0
    if (!belt.local && !this.callLines && !this.allConnections) return 0
    if (!this.inFocus(belt.from) || !this.inFocus(belt.to)) return BACKGROUND_BELT
    return this.run.active ? DIMMED_BELT : 1
  }

  // At rest a call is a quiet grey line. The answer's path is drawn over it, in drawThread.
  private drawBelts(frame: Frame) {
    const { back } = this
    back.save()
    for (const belt of this.scene.belts) {
      const alpha = this.beltAlpha(belt)
      if (alpha === 0) continue
      back.globalAlpha = alpha
      drawLine(back, belt.route, frame, belt.broken ? this.gapColour : null, true)
    }
    back.restore()
  }

  // Where the agent looked while investigating: a faint line under the path the final answer draws.
  private drawWalk(frame: Frame) {
    const { back } = this
    back.save()
    back.strokeStyle = this.pathColour
    back.globalAlpha = this.pin ? 0.25 * PINNED_ASIDE : 0.25
    back.lineWidth = 1.5
    back.setLineDash([4, 4])
    back.beginPath()
    this.run.walked.forEach((id, index) => {
      const route = index > 0 ? this.scene.routeOf(this.run.walked[index - 1], id) : null
      if (route) traceRoute(back, route, 1, frame)
    })
    back.stroke()
    back.restore()
  }

  // The answer's path is drawn step by step: a solid line where the link is proven, dashed in the gap colour where it
  // isn't. An arrowhead halfway along each step shows the direction.
  private drawThread(frame: Frame) {
    const { back } = this
    this.parcel = null
    const width = Math.max(MIN_PATH_WIDTH, PATH_WIDTH * frame.zoom)
    back.save()
    back.lineJoin = 'round'
    back.lineCap = 'round'
    this.run.segments.forEach((segment, index) => {
      const reach = Math.min(1, this.progress - index)
      const route = this.scene.routeOf(segment.from, segment.to)
      if (reach <= 0 || !route) return
      const colour = segment.dashed ? this.gapColour : this.pathColour
      const aside = !this.inFocus(segment.from, segment.to) || (this.pin && !this.isPinned(segment.from, segment.to))
      back.globalAlpha = aside ? PINNED_ASIDE : 1

      back.beginPath()
      const end = traceRoute(back, route, reach, frame)
      back.setLineDash(segment.dashed ? [8, 6].map((size) => size * Math.max(0.6, frame.zoom)) : [])
      back.strokeStyle = colour
      back.lineWidth = width
      back.stroke()
      back.setLineDash([])
      if (reach >= 1) this.drawArrow(route, frame, colour, width)
      else this.parcel = end
    })
    back.restore()
  }

  private drawArrow(route: Route, frame: Frame, colour: string, width: number) {
    const { back } = this
    const { zoom, pan } = frame
    const middle = route.length / 2
    const size = (ARROW_SIZE + width) / zoom
    const tip = pointAlong(route, middle + size / 2)
    const tail = pointAlong(route, middle - size / 2)
    const normal = route.normals[Math.round((middle - size / 2) / route.step)]
    const spread = size * 0.75
    back.beginPath()
    back.moveTo((tail.x + normal.x * spread) * zoom + pan.x, (tail.y + normal.y * spread) * zoom + pan.y)
    back.lineTo(tip.x * zoom + pan.x, tip.y * zoom + pan.y)
    back.lineTo((tail.x - normal.x * spread) * zoom + pan.x, (tail.y - normal.y * spread) * zoom + pan.y)
    back.closePath()
    back.fillStyle = colour
    back.fill()
  }

  // The step the agent is on gets a soft pulsing ring.
  private drawCurrent(zoom: number, pan: Point, now: number) {
    const id = this.run.current
    if (!id) return
    const point = this.screen(id, zoom, pan)
    if (!point) return
    const { back } = this
    const pulse = this.reducedMotion.matches ? 0.5 : 0.5 + 0.5 * Math.sin(now / 220)
    back.save()
    back.strokeStyle = this.pathColour
    back.lineWidth = 2
    back.globalAlpha = 0.35 + 0.45 * pulse
    back.beginPath()
    back.arc(point.x, point.y, (CURRENT_RING + 3 * pulse) * Math.max(0.7, zoom), 0, Math.PI * 2)
    back.stroke()
    back.restore()
  }

  // A small marker rides the front of the path while it is being drawn.
  private drawParcel(frame: Frame) {
    const parcel = this.parcel
    if (!parcel) return
    const { front } = this
    const radius = 5 * Math.min(1.2, Math.max(0.9, frame.zoom))
    front.save()
    front.beginPath()
    front.arc(parcel.x, parcel.y, radius, 0, Math.PI * 2)
    front.fillStyle = this.pathColour
    front.fill()
    front.lineWidth = 2
    front.strokeStyle = this.background
    front.stroke()
    front.restore()
  }
}
