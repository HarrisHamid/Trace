import type { Core } from 'cytoscape'

import { beltHalfWidth, drawConveyor, drawLegs, drawLine, pointAlong, sliceRoute, traceRoute, type Route } from '@/lib/belt'
import { cssVar } from '@/lib/css'
import { LabelPainter, type Frame, type LitStar } from '@/lib/pills'
import { STEP_MS, type GraphNode, type Segment, type StarStatus } from '@/lib/run'
import { PLATE_DEPTH, type Belt, type Box, type Plate, type Point, type Scene } from '@/lib/scene'

// Everything Cytoscape can't draw. Two canvases sandwich it: behind, the starfield, the plates, the glows and the
// answer's belt; in front, the label cards, the drifting packages and the parcel that rides the answer.
// Stars are seeded, because the map must look identical on every run.

const STAR_COUNT = 900
const STAR_SEED = 20261031
const STAR_PARALLAX = 0.12
const TWINKLE_COUNT = 48
const GRATICULE_STEP = 260
const GRATICULE_RINGS = 16
const GLOW_RADIUS = 46
const OUTLINE_PADDING = 34
const IDLE_FRAME_MS = 32
const PLATE_RADIUS = 14
const BELT_SPEED = 46
const DIMMED_PLATE = 0.55
const BACKGROUND_PLATE = 0.22
const DIMMED_BELT = 0.16
const BACKGROUND_BELT = 0.07

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

interface Package {
  from: string
  to: string
  colour: string
  route: Route
  phase: number
}

interface Twinkle {
  x: number
  y: number
  size: number
  phase: number
  speed: number
}

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function glowSprite(hex: string, peak: number): HTMLCanvasElement {
  const sprite = document.createElement('canvas')
  sprite.width = sprite.height = 256
  const context = sprite.getContext('2d')!
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128)
  gradient.addColorStop(0, `rgba(${r},${g},${b},${peak})`)
  gradient.addColorStop(0.4, `rgba(${r},${g},${b},${peak * 0.32})`)
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`)
  context.fillStyle = gradient
  context.fillRect(0, 0, 256, 256)
  return sprite
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
  private readonly plateGlows = new Map<string, HTMLCanvasElement>()
  private readonly glows: Record<StarStatus | 'hover' | 'parcel', HTMLCanvasElement>
  private readonly packages: Package[] = []
  private readonly twinkles: Twinkle[] = []
  private readonly gold = cssVar('--status-verified')
  private readonly ice = cssVar('--status-gap')
  private readonly parcelColour = cssVar('--parcel')
  private readonly background = cssVar('--background')
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly origin: Point
  private readonly nodeModule = new Map<string, string>()
  private starfield = document.createElement('canvas')
  private run = EMPTY_RUN
  private litPlates = new Set<string>()
  private lit = new Map<string, LitStar>()
  private progress = 0
  private hover: string | null = null
  private selected: string | null = null
  private focusModule: string | null = null
  private outlines: Box[] = []
  private parcel: Parcel | null = null
  private width = 0
  private height = 0
  private frame = 0
  private lastTick = 0
  private lastDraw = 0

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

    for (const plate of scene.plates) this.plateGlows.set(plate.id, glowSprite(plate.colour, 0.55))
    this.glows = {
      visited: glowSprite(this.gold, 0.9),
      verified: glowSprite(this.gold, 0.9),
      unverified: glowSprite(cssVar('--status-unverified'), 0.9),
      gap: glowSprite(this.ice, 0.9),
      hover: glowSprite('#dfe3f0', 0.55),
      parcel: glowSprite(this.parcelColour, 0.85),
    }

    const random = seededRandom(STAR_SEED + 1)
    for (const belt of scene.belts) {
      if (belt.broken) continue
      this.packages.push({ from: belt.from, to: belt.to, colour: belt.colour, route: belt.route, phase: random() })
    }
    for (let index = 0; index < TWINKLE_COUNT; index += 1) {
      this.twinkles.push({
        x: random(),
        y: random(),
        size: 0.8 + random() * 1.1,
        phase: random() * Math.PI * 2,
        speed: 0.6 + random() * 1.4,
      })
    }

    this.origin = { x: scene.bounds.x1 - 360, y: scene.bounds.y2 + 520 }
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
    this.renderStarfield()
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
    this.schedule()
  }

  setSelected(id: string | null) {
    this.selected = id
    this.schedule()
  }

  setFocusModule(module: string | null) {
    this.focusModule = module
    this.outlines = module === null ? [] : this.classOutlines(module)
    this.schedule()
  }

  destroy() {
    cancelAnimationFrame(this.frame)
  }

  private get target() {
    return Math.max(0, Math.min(this.run.revealed - 1, this.run.segments.length))
  }

  private get keepGoing() {
    return !this.reducedMotion.matches || this.progress < this.target
  }

  private schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(this.tick)
  }

  // The loop idles at about 30fps for the drifting packages and runs flat out while the answer's belt is being laid.
  private tick = (now: number) => {
    this.frame = 0
    const laying = this.progress < this.target
    if (!laying && now - this.lastDraw < IDLE_FRAME_MS) {
      this.schedule()
      return
    }
    const elapsed = this.lastTick ? now - this.lastTick : 16
    this.lastTick = now
    this.lastDraw = now
    this.progress = this.reducedMotion.matches ? this.target : Math.min(this.target, this.progress + elapsed / STEP_MS)
    this.draw(now)
    if (this.keepGoing) this.schedule()
    else this.lastTick = 0
  }

  draw = (now = performance.now()) => {
    const zoom = this.cy.zoom()
    const pan = this.cy.pan()
    const frame: Frame = { zoom, pan, now, width: this.width, height: this.height }
    this.drawBack(frame)
    this.drawFront(frame)
  }

  private plateAlpha = (plate: Plate) => {
    let alpha = 1
    if (this.focusModule !== null && plate.id !== this.focusModule) alpha = BACKGROUND_PLATE
    if (this.run.active && !this.litPlates.has(plate.id)) alpha *= DIMMED_PLATE
    return alpha
  }

  private drawBack(frame: Frame) {
    const { zoom, pan, now } = frame
    this.back.fillStyle = this.background
    this.back.fillRect(0, 0, this.width, this.height)
    this.drawStarfield(pan)
    this.drawTwinkle(now)
    this.drawGraticule(zoom, pan)
    this.drawPlates(zoom, pan)
    this.drawOutlines(zoom, pan)
    this.drawBelts(frame)
    this.drawWalk(frame)
    this.drawThread(frame)
    this.drawGlows(zoom, pan, now)
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
      plateAlpha: this.plateAlpha,
    }
    this.drawPackages(frame)
    this.painter.drawPills(front, frame, state)
    this.painter.drawPlateLabels(front, frame, state)
    this.drawParcel(frame)
  }

  private renderStarfield() {
    const { width, height } = this
    this.starfield.width = width
    this.starfield.height = height
    const context = this.starfield.getContext('2d')!
    const random = seededRandom(STAR_SEED)
    for (let index = 0; index < STAR_COUNT; index += 1) {
      const magnitude = random() ** 3
      context.globalAlpha = 0.14 + magnitude * 0.5
      context.fillStyle = random() < 0.2 ? '#ffe9c4' : '#cfdcff'
      context.beginPath()
      context.arc(random() * width, random() * height, 0.3 + magnitude * 0.8, 0, Math.PI * 2)
      context.fill()
    }
  }

  private drawStarfield(pan: Point) {
    const { back, width, height } = this
    const x = ((pan.x * STAR_PARALLAX) % width + width) % width
    const y = ((pan.y * STAR_PARALLAX) % height + height) % height
    for (const offsetX of [x - width, x]) {
      for (const offsetY of [y - height, y]) back.drawImage(this.starfield, offsetX, offsetY, width, height)
    }
  }

  private drawTwinkle(now: number) {
    const { back, width, height } = this
    const still = this.reducedMotion.matches
    back.save()
    back.fillStyle = '#e8eeff'
    for (const star of this.twinkles) {
      back.globalAlpha = still ? 0.4 : 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(now / 1000 * star.speed + star.phase))
      back.beginPath()
      back.arc(star.x * width, star.y * height, star.size, 0, Math.PI * 2)
      back.fill()
    }
    back.restore()
  }

  // Faint rings only. Anything stronger competes with the belts.
  private drawGraticule(zoom: number, pan: Point) {
    const { back, origin } = this
    const x = origin.x * zoom + pan.x
    const y = origin.y * zoom + pan.y
    back.save()
    back.strokeStyle = 'rgba(196,206,232,0.035)'
    back.lineWidth = 1
    back.beginPath()
    for (let ring = 1; ring <= GRATICULE_RINGS; ring += 1) {
      const radius = ring * GRATICULE_STEP * zoom
      back.moveTo(x + radius, y)
      back.arc(x, y, radius, 0, Math.PI * 2)
    }
    back.stroke()
    back.restore()
  }

  // Each module is a dark plate with some thickness, a coloured trim along its top edge and four screws.
  private drawPlates(zoom: number, pan: Point) {
    const { back } = this
    for (const plate of this.scene.plates) {
      const alpha = this.plateAlpha(plate)
      const x = plate.box.x1 * zoom + pan.x
      const y = plate.box.y1 * zoom + pan.y
      const width = (plate.box.x2 - plate.box.x1) * zoom
      const height = (plate.box.y2 - plate.box.y1) * zoom
      const radius = PLATE_RADIUS * zoom
      const depth = PLATE_DEPTH * zoom
      if (x > this.width || y > this.height || x + width < 0 || y + height < 0) continue

      back.save()
      back.globalAlpha = alpha * 0.3
      back.globalCompositeOperation = 'screen'
      const glow = this.plateGlows.get(plate.id)!
      const size = Math.max(width, height) * 1.3
      back.drawImage(glow, x + width / 2 - size / 2, y + height / 2 - size / 2, size, size)
      back.restore()

      back.save()
      back.globalAlpha = alpha
      back.beginPath()
      back.roundRect(x + 5 * zoom, y + depth + 12 * zoom, width, height, radius)
      back.fillStyle = 'rgba(0,0,0,0.4)'
      back.fill()

      back.beginPath()
      back.roundRect(x, y + depth, width, height, radius)
      back.fillStyle = '#06070b'
      back.fill()

      const face = back.createLinearGradient(0, y, 0, y + height)
      face.addColorStop(0, 'rgba(27,31,44,0.96)')
      face.addColorStop(1, 'rgba(15,17,26,0.96)')
      back.beginPath()
      back.roundRect(x, y, width, height, radius)
      back.fillStyle = face
      back.fill()
      back.lineWidth = 1
      back.strokeStyle = plate.external ? 'rgba(196,206,232,0.22)' : 'rgba(196,206,232,0.14)'
      back.setLineDash(plate.external ? [6, 5] : [])
      back.stroke()
      back.setLineDash([])

      back.beginPath()
      back.moveTo(x + radius, y + 1.5)
      back.lineTo(x + width - radius, y + 1.5)
      back.lineWidth = Math.max(2, 3 * zoom)
      back.lineCap = 'round'
      back.strokeStyle = plate.colour
      back.stroke()

      back.fillStyle = 'rgba(196,206,232,0.16)'
      const inset = 12 * zoom
      for (const [sx, sy] of [
        [x + inset, y + inset],
        [x + width - inset, y + inset],
        [x + inset, y + height - inset],
        [x + width - inset, y + height - inset],
      ]) {
        back.beginPath()
        back.arc(sx, sy, Math.max(1.5, 2.2 * zoom), 0, Math.PI * 2)
        back.fill()
      }
      back.restore()
    }
  }

  private classOutlines(module: string): Box[] {
    const classes = this.nodes.filter((node) => node.type === 'class' && node.module === module)
    return classes.map((owner) => {
      const members = this.nodes.filter((node) => node.id === owner.id || node.id.startsWith(`${owner.id}.`))
      const xs = members.map((node) => node.x ?? 0)
      const ys = members.map((node) => node.y ?? 0)
      return {
        x1: Math.min(...xs) - OUTLINE_PADDING,
        y1: Math.min(...ys) - OUTLINE_PADDING,
        x2: Math.max(...xs) + OUTLINE_PADDING,
        y2: Math.max(...ys) + OUTLINE_PADDING + 16,
      }
    })
  }

  private drawOutlines(zoom: number, pan: Point) {
    const { back } = this
    back.save()
    back.strokeStyle = 'rgba(241,223,174,0.28)'
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
    if (this.focusModule === null) return true
    return ids.some((id) => this.nodeModule.get(id) === this.focusModule)
  }

  private beltAlpha(belt: Belt) {
    if (!this.inFocus(belt.from) || !this.inFocus(belt.to)) return BACKGROUND_BELT
    return this.run.active ? DIMMED_BELT : 1
  }

  private flow(frame: Frame) {
    return this.reducedMotion.matches ? 0 : (frame.now / 1000) * BELT_SPEED
  }

  // At rest a call is a quiet line. The conveyor is saved for the answer, in drawThread.
  private drawBelts(frame: Frame) {
    const { back } = this
    const still = this.reducedMotion.matches
    back.save()
    for (const belt of this.scene.belts) {
      back.globalAlpha = this.beltAlpha(belt)
      drawLine(back, belt.route, frame, belt.broken ? this.ice : null, still)
    }
    back.restore()
  }

  // The agent's footsteps: a thin line under the bright belt that the final answer lays.
  private drawWalk(frame: Frame) {
    const { back } = this
    back.save()
    back.strokeStyle = this.gold
    back.globalAlpha = 0.3
    back.lineWidth = 1.5
    back.beginPath()
    this.run.walked.forEach((id, index) => {
      const route = index > 0 ? this.scene.routeOf(this.run.walked[index - 1], id) : null
      if (route) traceRoute(back, route, 1, frame)
    })
    back.stroke()
    back.restore()
  }

  // The answer lays a real conveyor as the parcel travels: brass rails where the link is firm, broken blue where it isn't.
  private drawThread(frame: Frame) {
    const { back } = this
    this.parcel = null
    const half = beltHalfWidth(frame.zoom)
    back.save()
    back.lineJoin = 'round'
    this.run.segments.forEach((segment, index) => {
      const reach = Math.min(1, this.progress - index)
      const route = this.scene.routeOf(segment.from, segment.to)
      if (reach <= 0 || !route) return
      const colour = segment.dashed ? this.ice : this.gold
      back.globalAlpha = this.inFocus(segment.from, segment.to) ? 1 : 0.12

      back.beginPath()
      const end = traceRoute(back, route, reach, frame)
      if (!segment.dashed) {
        back.shadowColor = colour
        back.shadowBlur = 16
        back.strokeStyle = colour
        back.lineWidth = half * 2
        back.stroke()
        back.shadowBlur = 0
      }

      const laid = sliceRoute(route, reach)
      drawLegs(back, laid, frame)
      drawConveyor(back, laid, frame, this.flow(frame), colour, segment.dashed)
      if (reach < 1) this.parcel = end
    })
    back.restore()
  }

  private drawGlows(zoom: number, pan: Point, now: number) {
    const { back } = this
    const base = GLOW_RADIUS * 2 * (0.6 + 0.4 * zoom)
    const stamp = (id: string, sprite: HTMLCanvasElement, scale: number) => {
      const point = this.screen(id, zoom, pan)
      if (!point) return
      const size = base * scale
      back.drawImage(sprite, point.x - size / 2, point.y - size / 2, size, size)
    }
    back.save()
    back.globalCompositeOperation = 'lighter'
    for (const { id, status } of this.run.lit) {
      back.globalAlpha = this.inFocus(id) ? 1 : 0.1
      const pulsing = id === this.run.current && !this.reducedMotion.matches
      stamp(id, this.glows[status], pulsing ? 1.5 + Math.sin(now / 130) * 0.3 : 1)
    }
    back.globalAlpha = 1
    if (this.hover) stamp(this.hover, this.glows.hover, 0.8)
    back.restore()
  }

  // Small dim packages drift along every line in its direction, so the map reads as a machine that is running.
  private drawPackages(frame: Frame) {
    if (this.reducedMotion.matches) return
    const { front } = this
    const { zoom, pan, now } = frame
    const size = 3.6 * Math.min(1.2, Math.max(0.8, zoom))
    front.save()
    front.globalAlpha = this.run.active ? 0.12 : 0.65
    for (const pack of this.packages) {
      if (!this.inFocus(pack.from) || !this.inFocus(pack.to)) continue
      const { route } = pack
      const point = pointAlong(route, (((now / 1000) * BELT_SPEED) / route.length + pack.phase) % 1 * route.length)
      front.fillStyle = pack.colour
      front.beginPath()
      front.roundRect(point.x * zoom + pan.x - size / 2, point.y * zoom + pan.y - size / 2, size, size, 1)
      front.fill()
    }
    front.restore()
  }

  // The answer travels as an orange crate, like the packages on the factory belt.
  private drawParcel(frame: Frame) {
    const parcel = this.parcel
    if (!parcel) return
    const { front } = this
    const scale = Math.min(1.2, Math.max(0.9, frame.zoom))
    const size = 15 * scale
    front.save()
    front.globalCompositeOperation = 'lighter'
    front.drawImage(this.glows.parcel, parcel.x - 38 * scale, parcel.y - 38 * scale, 76 * scale, 76 * scale)
    front.globalCompositeOperation = 'source-over'
    front.beginPath()
    front.roundRect(parcel.x - size / 2, parcel.y - size / 2, size, size, 3 * scale)
    front.fillStyle = this.parcelColour
    front.fill()
    front.lineWidth = 1.25
    front.strokeStyle = '#7a3d0b'
    front.stroke()
    front.beginPath()
    front.moveTo(parcel.x - size / 2, parcel.y)
    front.lineTo(parcel.x + size / 2, parcel.y)
    front.moveTo(parcel.x, parcel.y - size / 2)
    front.lineTo(parcel.x, parcel.y + size / 2)
    front.strokeStyle = 'rgba(255,236,206,0.75)'
    front.lineWidth = 1.5
    front.stroke()
    front.restore()
  }
}
