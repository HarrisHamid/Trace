import { cssVar } from '@/lib/css'
import type { Claim } from '@/types/contracts/events.schema'

// The landing page's double helix. One strand is the answer, the other is the code, and every rung is a claim joining
// them. The parcel rides the answer and settles each rung it passes, drawn as on the map: solid for verified, hollow for
// unverified, broken for gap. Two canvases sandwich the wordmark, so the helix weaves through the letters.
// Lengths are in radii, so the shape holds at any size. The radius comes from the height of the wordmark.

const TILT = -0.17
const TURN_LENGTH = 3.4
const RUNGS_PER_TURN = 10.5
const CAMERA = 6
const ANCHOR_RADIUS = 0.55
const ANCHOR_DROP = 0.05

// Real DNA's strands are not opposite each other, which is what gives it a wide groove and a narrow one.
const GROOVE = 2.3
const SAMPLE_STEP = 5
const DEPTH_BANDS = 10
const KNOCKOUT = 3.5

const SPIN = 0.42
const SWEEP_SECONDS = 15
const OPEN_SECONDS = 1.9
const TAIL_TURNS = 0.6
const TAIL_PIECES = 8
const FLASH_LENGTH = 1.1
const STILL_PARCEL = 0.72

// The pointer unwinds the helix. The twist it removes bunches up either side, as it does on a real rope, so the helix
// beyond that stays where it was.
const UNWIND_WIDTH = 1.6
const UNWIND_TWIST = 2.1
const UNWIND_SWELL = 0.42
const UNWIND_REACH = 1.2
const UNWIND_FALLOFF = 1.8
const POINTER_EASE = 7

interface Anchor {
  x: number
  y: number
  height: number
}

interface Bead {
  x: number
  y: number
  depth: number
}

// Fixed, not random, because the helix must look the same on every visit.
function rungStatus(index: number): Claim['status'] {
  if (index % 31 === 12) return 'gap'
  return index % 13 === 5 ? 'unverified' : 'verified'
}

export class Helix {
  private readonly backCanvas: HTMLCanvasElement
  private readonly frontCanvas: HTMLCanvasElement
  private readonly back: CanvasRenderingContext2D
  private readonly front: CanvasRenderingContext2D
  private readonly still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  private readonly page = cssVar('--background')
  private readonly answer = cssVar('--foreground')
  private readonly code = cssVar('--belt')
  private readonly parcel = cssVar('--parcel')
  private readonly status: Record<Claim['status'], string> = {
    verified: cssVar('--status-verified'),
    unverified: cssVar('--status-unverified'),
    gap: cssVar('--status-gap'),
  }
  private width = 0
  private height = 0
  private centre = { x: 0, y: 0 }
  private radius = 1
  private reach = 0
  private span = 1
  private clock = 0
  private opened = 0
  private lens = { along: 0, aim: 0, strength: 0, target: 0 }
  private frame = 0
  private lastTick = 0

  constructor(back: HTMLCanvasElement, front: HTMLCanvasElement) {
    this.backCanvas = back
    this.frontCanvas = front
    this.back = back.getContext('2d')!
    this.front = front.getContext('2d')!
    if (this.still) this.opened = 1
  }

  private get rungStep() {
    return (TURN_LENGTH * this.radius) / RUNGS_PER_TURN
  }

  private get weight() {
    return Math.min(1.25, Math.max(0.6, this.radius / 115))
  }

  private get parcelAt() {
    const swept = this.still ? STILL_PARCEL : (this.clock / SWEEP_SECONDS) % 1
    return -this.reach + swept * this.span
  }

  resize(width: number, height: number, anchor: Anchor) {
    const scale = Math.min(window.devicePixelRatio || 1, 2)
    this.width = width
    this.height = height
    this.radius = anchor.height * ANCHOR_RADIUS
    this.centre = { x: anchor.x, y: anchor.y + anchor.height * ANCHOR_DROP }
    this.reach = Math.hypot(Math.max(anchor.x, width - anchor.x), Math.max(anchor.y, height - anchor.y)) + this.radius
    this.span = Math.ceil((2 * this.reach) / this.rungStep) * this.rungStep
    for (const [canvas, context] of [[this.backCanvas, this.back], [this.frontCanvas, this.front]] as const) {
      canvas.width = Math.floor(width * scale)
      canvas.height = Math.floor(height * scale)
      context.setTransform(scale, 0, 0, scale, 0, 0)
      context.lineJoin = 'round'
    }
    this.draw()
  }

  pointAt(x: number, y: number) {
    if (this.still) return
    const dx = x - this.centre.x
    const dy = y - this.centre.y
    const across = Math.abs(dy * Math.cos(TILT) - dx * Math.sin(TILT)) / this.radius
    this.lens.target = Math.min(1, Math.max(0, 1 - (across - UNWIND_REACH) / UNWIND_FALLOFF))
    this.lens.aim = dx * Math.cos(TILT) + dy * Math.sin(TILT)
    // With no strength left there is nothing to slide, so it starts under the cursor instead of where it last was.
    if (this.lens.strength < 0.01) this.lens.along = this.lens.aim
  }

  release() {
    this.lens.target = 0
  }

  start() {
    if (this.still) return
    this.lastTick = performance.now()
    this.frame = requestAnimationFrame(this.tick)
  }

  destroy() {
    cancelAnimationFrame(this.frame)
  }

  private tick = (now: number) => {
    const elapsed = Math.min((now - this.lastTick) / 1000, 0.05)
    this.lastTick = now
    this.clock += elapsed
    this.opened = 1 - (1 - Math.min(1, this.clock / OPEN_SECONDS)) ** 3

    const ease = 1 - Math.exp(-elapsed * POINTER_EASE)
    this.lens.along += (this.lens.aim - this.lens.along) * ease
    this.lens.strength += (this.lens.target - this.lens.strength) * ease

    this.draw()
    this.frame = requestAnimationFrame(this.tick)
  }

  private place(along: number, offset: number): Bead {
    const { radius, opened, lens, centre } = this
    const x = (along - lens.along) / (UNWIND_WIDTH * radius)
    const bump = lens.strength * Math.exp(-x * x)
    const angle = (along / (TURN_LENGTH * radius)) * Math.PI * 2 - this.clock * SPIN - UNWIND_TWIST * x * bump + offset
    const reach = radius * opened * (1 + UNWIND_SWELL * bump)
    const across = Math.cos(angle) * reach
    const depth = Math.sin(angle)
    // Only the offset from the axis gets perspective. Applied along the axis too, it swings points far from the centre
    // sideways and the strands fold into loops.
    const lifted = across * (CAMERA / (CAMERA - (depth * reach) / radius))
    return {
      x: centre.x + along * Math.cos(TILT) - lifted * Math.sin(TILT),
      y: centre.y + along * Math.sin(TILT) + lifted * Math.cos(TILT),
      depth,
    }
  }

  private draw() {
    this.back.clearRect(0, 0, this.width, this.height)
    this.front.clearRect(0, 0, this.width, this.height)

    const first = Math.floor(-this.reach / this.rungStep)
    for (let index = 0; index * this.rungStep < this.span; index++) {
      this.drawRung(index, (first + index) * this.rungStep)
    }
    this.drawThread(-this.reach, this.reach, GROOVE, this.code, 0.9, 0)
    this.drawThread(-this.reach, this.reach, 0, this.answer, 1, 0)
    this.drawParcel()
  }

  private drawRung(index: number, along: number) {
    const status = rungStatus(index)
    const ends = [this.place(along, 0), this.place(along, GROOVE)]
    const middle = { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 }
    const behind = (((this.parcelAt - along) % this.span) + this.span) % this.span
    const freshness = (1 - behind / this.span) ** 2
    const flash = Math.max(0, 1 - behind / (FLASH_LENGTH * this.radius))
    const size = this.weight

    for (const end of ends) {
      const context = end.depth > 0 ? this.front : this.back
      const near = (end.depth + 1) / 2
      const reach = status === 'gap' ? 0.68 : 1
      context.globalAlpha = this.opened * (0.34 + 0.66 * freshness) * (0.5 + 0.5 * near)
      context.strokeStyle = this.status[status]
      context.fillStyle = this.status[status]
      context.lineWidth = ((status === 'verified' ? 1.5 : 1.1) + flash * 2) * size
      context.setLineDash(status === 'gap' ? [3 * size, 3.5 * size] : [])
      context.beginPath()
      context.moveTo(end.x, end.y)
      context.lineTo(end.x + (middle.x - end.x) * reach, end.y + (middle.y - end.y) * reach)
      context.stroke()
      context.setLineDash([])

      context.beginPath()
      context.arc(end.x, end.y, (1.7 + 1.5 * near + flash) * size, 0, Math.PI * 2)
      if (status === 'verified') {
        context.fill()
      } else {
        context.fillStyle = this.page
        context.fill()
        context.stroke()
      }
    }
  }

  // Depth changes the width and brightness, so a strand is stroked in runs of equal depth. Stroking each sample on its
  // own would bead wherever two translucent segments overlap.
  private drawThread(from: number, to: number, offset: number, colour: string, strength: number, boost: number) {
    const band = (bead: Bead) => Math.min(DEPTH_BANDS - 1, Math.floor(((bead.depth + 1) / 2) * DEPTH_BANDS))
    let run: Bead[] = []
    for (let along = from; along < to + SAMPLE_STEP; along += SAMPLE_STEP) {
      const bead = this.place(Math.min(along, to), offset)
      run.push(bead)
      if (run.length > 1 && band(bead) !== band(run[0])) {
        this.strokeRun(run, band(run[0]), colour, strength, boost)
        run = [bead]
      }
    }
    if (run.length > 1) this.strokeRun(run, band(run[0]), colour, strength, boost)
  }

  private strokeRun(run: Bead[], band: number, colour: string, strength: number, boost: number) {
    const near = (band + 0.5) / DEPTH_BANDS
    const inFront = band >= DEPTH_BANDS / 2
    const context = inFront ? this.front : this.back
    const width = (0.8 + 2.3 * near + boost) * this.weight

    context.beginPath()
    run.forEach((bead, index) => (index ? context.lineTo(bead.x, bead.y) : context.moveTo(bead.x, bead.y)))

    // The dark edge is what makes a strand read as passing over the letters: it cuts into them.
    if (inFront) {
      context.globalAlpha = this.opened
      context.strokeStyle = this.page
      context.lineWidth = width + KNOCKOUT * this.weight
      context.stroke()
    }
    context.globalAlpha = (0.2 + 0.8 * near) * strength
    context.strokeStyle = colour
    context.lineWidth = width
    context.stroke()
  }

  private drawParcel() {
    const at = this.parcelAt
    const step = (TAIL_TURNS * TURN_LENGTH * this.radius) / TAIL_PIECES
    for (let piece = 0; piece < TAIL_PIECES; piece++) {
      const to = at - piece * step
      this.drawThread(to - step, to, 0, this.parcel, (1 - piece / TAIL_PIECES) ** 2, 0.6)
    }

    const bead = this.place(at, 0)
    const size = (5 + 3 * ((bead.depth + 1) / 2)) * this.weight
    const context = bead.depth > 0 ? this.front : this.back
    context.save()
    context.translate(bead.x, bead.y)
    context.rotate(Math.PI / 4)
    context.globalAlpha = this.opened
    context.fillStyle = this.parcel
    context.shadowColor = this.parcel
    context.shadowBlur = 22
    context.fillRect(-size / 2, -size / 2, size, size)
    context.restore()
  }
}
