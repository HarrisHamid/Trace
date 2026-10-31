import type { Core } from 'cytoscape'

import { STEP_MS, type GraphNode, type Segment, type StarStatus } from '@/lib/run'

// Everything Cytoscape can't draw, on a canvas behind it: starfield, graticule, nebulae, glows and the agent's thread.
// Stars are seeded, because the map must look identical on every run.

const STAR_COUNT = 900
const STAR_SEED = 20261031
const STAR_PARALLAX = 0.12
const GRATICULE_STEP = 260
const GRATICULE_RINGS = 16
const GRATICULE_SPOKES = 24
const NEBULA_RADIUS = 300
const GLOW_RADIUS = 46
const OUTLINE_PADDING = 34

interface Point {
  x: number
  y: number
}

interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface SkyRun {
  walked: string[]
  segments: Segment[]
  revealed: number
  lit: { id: string; status: StarStatus }[]
  current: string | null
}

const EMPTY_RUN: SkyRun = { walked: [], segments: [], revealed: 0, lit: [], current: null }

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
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
  private readonly canvas: HTMLCanvasElement
  private readonly cy: Core
  private readonly nodes: GraphNode[]
  private readonly context: CanvasRenderingContext2D
  private readonly positions = new Map<string, Point>()
  private readonly nebulae: { module: string; sprite: HTMLCanvasElement; points: Point[] }[] = []
  private readonly glows: Record<StarStatus | 'hover', HTMLCanvasElement>
  private readonly gold = cssVar('--status-verified')
  private readonly ice = cssVar('--status-gap')
  private readonly background = cssVar('--background')
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly origin: Point
  private starfield = document.createElement('canvas')
  private run = EMPTY_RUN
  private progress = 0
  private hover: string | null = null
  private focusModule: string | null = null
  private outlines: Box[] = []
  private width = 0
  private height = 0
  private frame = 0
  private lastTick = 0

  constructor(canvas: HTMLCanvasElement, cy: Core, nodes: GraphNode[]) {
    this.canvas = canvas
    this.cy = cy
    this.nodes = nodes
    this.context = canvas.getContext('2d')!
    for (const node of nodes) this.positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 })

    const stars = nodes.filter((node) => node.type !== 'module' && node.type !== 'external')
    const modules = [...new Set(stars.map((node) => node.module))].sort()
    modules.forEach((module, index) => {
      const sprite = glowSprite(cssVar(`--nebula-${(index % 4) + 1}`), 0.5)
      const points = stars.filter((node) => node.module === module).map((node) => this.positions.get(node.id)!)
      this.nebulae.push({ module, sprite, points })
    })

    this.glows = {
      visited: glowSprite(this.gold, 0.9),
      verified: glowSprite(this.gold, 0.9),
      unverified: glowSprite(cssVar('--status-unverified'), 0.9),
      gap: glowSprite(this.ice, 0.9),
      hover: glowSprite(cssVar('--star-function'), 0.55),
    }

    const xs = nodes.map((node) => node.x ?? 0)
    const ys = nodes.map((node) => node.y ?? 0)
    this.origin = { x: Math.min(...xs) - 360, y: Math.max(...ys) + 520 }
    this.resize()
  }

  resize() {
    const scale = window.devicePixelRatio || 1
    const { width, height } = this.canvas.getBoundingClientRect()
    this.width = width
    this.height = height
    this.canvas.width = width * scale
    this.canvas.height = height * scale
    this.context.setTransform(scale, 0, 0, scale, 0, 0)
    this.renderStarfield()
    this.draw()
  }

  setRun(run: SkyRun) {
    const redrawn = run.segments.some((segment, index) => segment.to !== this.run.segments[index]?.to)
    if (redrawn || run.segments.length === 0) this.progress = 0
    this.run = run
    this.schedule()
  }

  setHover(id: string | null) {
    if (id === this.hover) return
    this.hover = id
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

  private get animating() {
    if (this.reducedMotion.matches) return false
    return this.progress < this.target || this.run.current !== null
  }

  private schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(this.tick)
  }

  private tick = (now: number) => {
    this.frame = 0
    const elapsed = this.lastTick ? now - this.lastTick : 16
    this.lastTick = now
    this.progress = this.reducedMotion.matches
      ? this.target
      : Math.min(this.target, this.progress + elapsed / STEP_MS)
    this.draw(now)
    if (this.animating) this.schedule()
    else this.lastTick = 0
  }

  draw = (now = performance.now()) => {
    const { context, width, height } = this
    const zoom = this.cy.zoom()
    const pan = this.cy.pan()
    context.fillStyle = this.background
    context.fillRect(0, 0, width, height)
    this.drawStarfield(pan)
    this.drawGraticule(zoom, pan)
    this.drawNebulae(zoom, pan)
    this.drawOutlines(zoom, pan)
    this.drawWalk(zoom, pan)
    this.drawThread(zoom, pan)
    this.drawGlows(zoom, pan, now)
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
    const { context, width, height } = this
    const x = ((pan.x * STAR_PARALLAX) % width + width) % width
    const y = ((pan.y * STAR_PARALLAX) % height + height) % height
    for (const offsetX of [x - width, x]) {
      for (const offsetY of [y - height, y]) context.drawImage(this.starfield, offsetX, offsetY, width, height)
    }
  }

  // A polar grid around a point off the chart, as on a planisphere.
  private drawGraticule(zoom: number, pan: Point) {
    const { context, origin } = this
    const x = origin.x * zoom + pan.x
    const y = origin.y * zoom + pan.y
    context.save()
    context.strokeStyle = 'rgba(196,206,232,0.06)'
    context.lineWidth = 1
    context.beginPath()
    for (let ring = 1; ring <= GRATICULE_RINGS; ring += 1) {
      const radius = ring * GRATICULE_STEP * zoom
      context.moveTo(x + radius, y)
      context.arc(x, y, radius, 0, Math.PI * 2)
    }
    const reach = GRATICULE_RINGS * GRATICULE_STEP * zoom
    for (let spoke = 0; spoke < GRATICULE_SPOKES; spoke += 1) {
      const angle = (spoke / GRATICULE_SPOKES) * Math.PI * 2
      context.moveTo(x + Math.cos(angle) * GRATICULE_STEP * zoom, y + Math.sin(angle) * GRATICULE_STEP * zoom)
      context.lineTo(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach)
    }
    context.stroke()
    context.restore()
  }

  private drawNebulae(zoom: number, pan: Point) {
    const { context } = this
    const size = NEBULA_RADIUS * 2 * zoom
    context.save()
    context.globalCompositeOperation = 'screen'
    for (const { module, sprite, points } of this.nebulae) {
      const focused = this.focusModule === module
      context.globalAlpha = this.focusModule === null ? 0.34 : focused ? 0.6 : 0.07
      for (const point of points) {
        context.drawImage(sprite, point.x * zoom + pan.x - size / 2, point.y * zoom + pan.y - size / 2, size, size)
      }
    }
    context.restore()
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
        y2: Math.max(...ys) + OUTLINE_PADDING,
      }
    })
  }

  private drawOutlines(zoom: number, pan: Point) {
    const { context } = this
    context.save()
    context.strokeStyle = 'rgba(241,223,174,0.2)'
    context.lineWidth = 1
    for (const box of this.outlines) {
      context.beginPath()
      context.roundRect(
        box.x1 * zoom + pan.x,
        box.y1 * zoom + pan.y,
        (box.x2 - box.x1) * zoom,
        (box.y2 - box.y1) * zoom,
        8 * zoom,
      )
      context.stroke()
    }
    context.restore()
  }

  private screen(id: string, zoom: number, pan: Point): Point | null {
    const point = this.positions.get(id)
    return point ? { x: point.x * zoom + pan.x, y: point.y * zoom + pan.y } : null
  }

  private inFocus(...ids: string[]) {
    if (this.focusModule === null) return true
    return this.nodes.some((node) => ids.includes(node.id) && node.module === this.focusModule)
  }

  // The agent's footsteps: a thin line under the bright path that the final answer draws.
  private drawWalk(zoom: number, pan: Point) {
    const { context } = this
    const points = this.run.walked.map((id) => this.screen(id, zoom, pan))
    context.save()
    context.strokeStyle = this.gold
    context.globalAlpha = 0.28
    context.lineWidth = 1
    context.beginPath()
    points.forEach((point, index) => {
      if (point && index === 0) context.moveTo(point.x, point.y)
      else if (point) context.lineTo(point.x, point.y)
    })
    context.stroke()
    context.restore()
  }

  private drawThread(zoom: number, pan: Point) {
    const { context } = this
    let head: Point | null = null
    context.save()
    context.lineCap = 'round'
    context.lineWidth = 2
    context.shadowBlur = 14
    this.run.segments.forEach((segment, index) => {
      const reach = Math.min(1, this.progress - index)
      const from = this.screen(segment.from, zoom, pan)
      const to = this.screen(segment.to, zoom, pan)
      if (reach <= 0 || !from || !to) return
      const end = { x: from.x + (to.x - from.x) * reach, y: from.y + (to.y - from.y) * reach }
      const colour = segment.dashed ? this.ice : this.gold
      context.strokeStyle = colour
      context.shadowColor = colour
      context.globalAlpha = this.inFocus(segment.from, segment.to) ? 1 : 0.12
      context.setLineDash(segment.dashed ? [7, 8] : [])
      context.beginPath()
      context.moveTo(from.x, from.y)
      context.lineTo(end.x, end.y)
      context.stroke()
      if (reach < 1) head = end
    })
    if (head) {
      const { x, y } = head as Point
      context.setLineDash([])
      context.fillStyle = '#ffffff'
      context.shadowColor = this.gold
      context.shadowBlur = 22
      context.beginPath()
      context.arc(x, y, 3, 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }

  private drawGlows(zoom: number, pan: Point, now: number) {
    const { context } = this
    const base = GLOW_RADIUS * 2 * (0.6 + 0.4 * zoom)
    const stamp = (id: string, sprite: HTMLCanvasElement, scale: number) => {
      const point = this.screen(id, zoom, pan)
      if (!point) return
      const size = base * scale
      context.drawImage(sprite, point.x - size / 2, point.y - size / 2, size, size)
    }
    context.save()
    context.globalCompositeOperation = 'lighter'
    for (const { id, status } of this.run.lit) {
      context.globalAlpha = this.inFocus(id) ? 1 : 0.1
      const pulsing = id === this.run.current && !this.reducedMotion.matches
      stamp(id, this.glows[status], pulsing ? 1.5 + Math.sin(now / 130) * 0.3 : 1)
    }
    context.globalAlpha = 1
    if (this.hover) stamp(this.hover, this.glows.hover, 0.8)
    context.restore()
  }
}
