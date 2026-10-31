import { cssVar } from '@/lib/css'
import type { GraphNode, StarStatus } from '@/lib/run'
import type { Plate, Point, Scene } from '@/lib/scene'

// The label cards drawn above the graph: one per node, a tab on every plate, and the plate captions. Text sizes are
// clamped so they stay readable when the camera pulls back, and a collision pass hides the lowest-priority labels
// instead of letting them pile up.

const MONO = '"JetBrains Mono Variable", monospace'
const CARD = 'rgba(10,12,19,0.93)'
const HAIRLINE = 'rgba(196,206,232,0.18)'
const TEXT = '#dfe2ee'
const MUTED = '#8f95ad'
const DARK = '#0a0c12'
const MIN_SCALE = 0.9
const MAX_SCALE = 1.2
const MIN_LABEL_ZOOM = 0.42
const MIN_CAPTION_ZOOM = 0.55

const NODE_RADIUS: Record<GraphNode['type'], number> = {
  route: 17,
  class: 13,
  dependency: 12,
  function: 10,
  external: 9,
  unresolved: 9,
  module: 0,
}

const PRIORITY: Record<GraphNode['type'], number> = {
  route: 3,
  class: 2,
  dependency: 1,
  function: 1,
  external: 0,
  unresolved: 1,
  module: -1,
}

export interface LitStar {
  letter: string
  status: StarStatus
}

export interface Frame {
  zoom: number
  pan: Point
  now: number
  width: number
  height: number
}

export interface PillState {
  lit: Map<string, LitStar>
  active: boolean
  hover: string | null
  selected: string | null
  focusModule: string | null
  plateAlpha: (plate: Plate) => number
}

interface Item {
  node: GraphNode
  x: number
  y: number
  width: number
  height: number
  priority: number
  alpha: number
  lit: LitStar | undefined
  value: string | null
}

function overlaps(a: Item, b: Item) {
  const margin = 3
  return (
    a.x < b.x + b.width + margin &&
    b.x < a.x + a.width + margin &&
    a.y < b.y + b.height + margin &&
    b.y < a.y + a.height + margin
  )
}

export class LabelPainter {
  private readonly widths = new Map<string, number>()
  private readonly nodes: GraphNode[]
  private readonly scene: Scene
  private readonly status: Record<StarStatus, string>

  constructor(nodes: GraphNode[], scene: Scene) {
    this.nodes = nodes
    this.scene = scene
    const gold = cssVar('--status-verified')
    this.status = {
      visited: gold,
      verified: gold,
      unverified: cssVar('--status-unverified'),
      gap: cssVar('--status-gap'),
    }
  }

  // Widths measured before the web fonts load are wrong, so they are measured again afterwards.
  reset() {
    this.widths.clear()
  }

  private measure(ctx: CanvasRenderingContext2D, font: string, text: string) {
    const key = `${font}|${text}`
    let width = this.widths.get(key)
    if (width === undefined) {
      ctx.font = font
      width = ctx.measureText(text).width
      this.widths.set(key, width)
    }
    return width
  }

  drawPills(ctx: CanvasRenderingContext2D, frame: Frame, state: PillState) {
    const { zoom, pan, width, height } = frame
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, zoom))
    const font = `${11 * scale}px ${MONO}`
    const small = `${9.5 * scale}px ${MONO}`
    const items: Item[] = []

    for (const node of this.nodes) {
      if (node.type === 'module') continue
      const lit = state.lit.get(node.id)
      const shown = node.id === state.hover || node.id === state.selected
      const forced = lit !== undefined || shown
      if (zoom < MIN_LABEL_ZOOM && !forced) continue
      const centre = this.scene.positions.get(node.id)!
      const x = centre.x * zoom + pan.x
      const y = centre.y * zoom + pan.y
      if (x < -120 || x > width + 120 || y < -60 || y > height + 60) continue

      const mark = lit ? 15 * scale : 8 * scale
      let cardWidth = 9 * scale + mark + 7 * scale + this.measure(ctx, font, node.name) + 9 * scale
      let cardHeight = 22 * scale
      let value: string | null = null
      if (shown) {
        const reach = this.scene.reach.get(node.id) ?? { calls: 0, calledBy: 0 }
        value = `calls ${reach.calls} · called by ${reach.calledBy}`
        cardWidth = Math.max(cardWidth, 18 * scale + this.measure(ctx, small, value))
        cardHeight += 15 * scale
      }
      let alpha = 1
      if (state.focusModule !== null && node.module !== state.focusModule) alpha = 0.12
      else if (state.active && !lit) alpha = 0.35
      items.push({
        node,
        x: x - cardWidth / 2,
        y: y + NODE_RADIUS[node.type] * zoom + 6 * scale,
        width: cardWidth,
        height: cardHeight,
        priority: forced ? 10 : PRIORITY[node.type],
        alpha,
        lit,
        value,
      })
    }

    items.sort((a, b) => b.priority - a.priority)
    const accepted: Item[] = []
    for (const item of items) {
      if (item.priority < 10 && accepted.some((other) => overlaps(other, item))) continue
      accepted.push(item)
    }

    ctx.save()
    ctx.textBaseline = 'middle'
    for (const item of accepted.reverse()) this.pill(ctx, item, scale, font, small)
    ctx.restore()
  }

  private pill(ctx: CanvasRenderingContext2D, item: Item, scale: number, font: string, small: string) {
    const { x, y, width, height, lit, node } = item
    const row = 22 * scale
    ctx.globalAlpha = item.alpha
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, 6 * scale)
    ctx.fillStyle = CARD
    ctx.fill()
    ctx.lineWidth = lit ? 1.5 : 1
    ctx.strokeStyle = lit ? this.status[lit.status] : HAIRLINE
    ctx.setLineDash(lit?.status === 'gap' ? [4, 3] : [])
    ctx.stroke()
    ctx.setLineDash([])

    if (lit) {
      const chip = 15 * scale
      ctx.beginPath()
      ctx.roundRect(x + 8 * scale, y + (row - chip) / 2, chip, chip, 3 * scale)
      ctx.fillStyle = this.status[lit.status]
      ctx.fill()
      ctx.fillStyle = DARK
      ctx.font = `700 ${10 * scale}px ${MONO}`
      ctx.textAlign = 'center'
      ctx.fillText(lit.letter, x + 8 * scale + chip / 2, y + row / 2 + 0.5)
    } else {
      const mark = 8 * scale
      ctx.beginPath()
      ctx.roundRect(x + 9 * scale, y + (row - mark) / 2, mark, mark, 2 * scale)
      ctx.fillStyle = this.scene.colourOf(node)
      ctx.fill()
    }

    ctx.textAlign = 'left'
    ctx.font = font
    ctx.fillStyle = TEXT
    ctx.fillText(node.name, x + 9 * scale + (lit ? 15 * scale : 8 * scale) + 7 * scale, y + row / 2 + 0.5)
    if (item.value) {
      ctx.font = small
      ctx.fillStyle = MUTED
      ctx.fillText(item.value, x + 9 * scale, y + row + 7 * scale)
    }
  }

  // Each plate's coloured tab and its one-line caption, like the nameplate on the front of a machine base.
  drawPlateLabels(ctx: CanvasRenderingContext2D, frame: Frame, state: PillState) {
    const { zoom, pan } = frame
    ctx.save()
    ctx.textBaseline = 'middle'
    for (const plate of this.scene.plates) {
      const tabWidth = (plate.tab.x2 - plate.tab.x1) * zoom
      const tabHeight = (plate.tab.y2 - plate.tab.y1) * zoom
      const x = plate.tab.x1 * zoom + pan.x
      const y = plate.tab.y1 * zoom + pan.y
      if (tabWidth < 24) continue
      ctx.globalAlpha = state.plateAlpha(plate)

      ctx.beginPath()
      ctx.roundRect(x, y, tabWidth, tabHeight, 7 * zoom)
      ctx.fillStyle = CARD
      ctx.fill()
      ctx.strokeStyle = HAIRLINE
      ctx.lineWidth = 1
      ctx.stroke()

      const mark = 10 * zoom
      ctx.beginPath()
      ctx.roundRect(x + 12 * zoom, y + (tabHeight - mark) / 2, mark, mark, 2.5 * zoom)
      ctx.fillStyle = plate.colour
      ctx.fill()

      ctx.font = `700 ${Math.max(8.5, 12 * zoom)}px ${MONO}`
      ctx.letterSpacing = `${1.4 * zoom}px`
      ctx.fillStyle = TEXT
      ctx.textAlign = 'left'
      ctx.fillText(plate.name.toUpperCase(), x + 30 * zoom, y + tabHeight / 2 + 0.5)
      ctx.letterSpacing = '0px'

      if (plate.caption && zoom >= MIN_CAPTION_ZOOM) {
        ctx.font = `${Math.max(8.5, 10 * Math.min(zoom, 1.1))}px ${MONO}`
        ctx.fillStyle = MUTED
        ctx.fillText(
          plate.caption,
          plate.box.x1 * zoom + pan.x + TAB_INSET * zoom,
          plate.tab.y2 * zoom + pan.y + 14 * zoom,
          (plate.box.x2 - plate.box.x1 - TAB_INSET * 2) * zoom,
        )
      }
    }
    ctx.restore()
  }
}

const TAB_INSET = 22
