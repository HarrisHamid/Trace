import type { Frame } from '@/lib/pills'
import type { Point } from '@/lib/scene'

// At rest a call on the map is a thin glowing line. The answer is drawn as a conveyor over the same route, seen from the
// same angle as the plates: rails, a slatted belt, a dark underside and legs. Its slats are shallow chevrons, so they point
// the way it runs even in a still frame. A route is sampled at even steps, in model units, so a distance along it is an
// array lookup.

const BEND = 0.55
const LEAVE_RATIO = 0.45
const CURVE_SAMPLES = 48
const ROUTE_STEP = 8

const HALF_WIDTH = 7.5
const MIN_HALF_WIDTH = 3.2
const BELLY = 5
const RAIL = 2.3
const MIN_RAIL = 1
const SLAT_SPACING = 12
const MIN_SLAT_PIXELS = 7
const CHEVRON = 0.7
const LEG_SPACING = 110
const LEG_HEIGHT = 20
const LEG_WIDTH = 3.4
const DETAIL_ZOOM = 0.42
const BROKEN_DASH = [26, 15]

const LINE_WIDTH = 1.5
const MIN_LINE_WIDTH = 1
const LINE_DASH = [7, 6]
const MARK_SIZE = 5

const SURFACE = '#2a2f3c'
const UNDERSIDE = '#05060a'
const SLAT = 'rgba(214,220,232,0.42)'
const RAIL_SHINE = '#dde2ec'
const LEG_SHADE = '#3c4250'
const LEG_SHINE = '#9aa1b1'
const LINE = '#eef2ff'
const LINE_GLOW = 'rgba(148,178,255,0.1)'

export interface Route {
  points: Point[]
  normals: Point[]
  length: number
  step: number
}

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  const at = (a: number, b: number, c: number, d: number) =>
    u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
  return { x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) }
}

// Belts leave and arrive along their longer axis, which gives the S-bends of a factory floor instead of diagonals.
export function routeBetween(from: Point, to: Point): Route {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const sideways = Math.abs(dx) >= Math.abs(dy) * LEAVE_RATIO
  const first = sideways ? { x: from.x + dx * BEND, y: from.y } : { x: from.x, y: from.y + dy * BEND }
  const second = sideways ? { x: to.x - dx * BEND, y: to.y } : { x: to.x, y: to.y - dy * BEND }

  const curve = Array.from({ length: CURVE_SAMPLES + 1 }, (_, index) =>
    bezier(from, first, second, to, index / CURVE_SAMPLES),
  )
  const travelled = [0]
  for (let index = 1; index < curve.length; index += 1) {
    const step = Math.hypot(curve[index].x - curve[index - 1].x, curve[index].y - curve[index - 1].y)
    travelled.push(travelled[index - 1] + step)
  }

  const length = travelled[CURVE_SAMPLES]
  const count = Math.max(2, Math.ceil(length / ROUTE_STEP) + 1)
  const step = length / (count - 1)
  const points: Point[] = []
  let segment = 1
  for (let index = 0; index < count; index += 1) {
    const distance = index * step
    while (segment < CURVE_SAMPLES && travelled[segment] < distance) segment += 1
    const span = travelled[segment] - travelled[segment - 1]
    const blend = span > 0 ? (distance - travelled[segment - 1]) / span : 0
    points.push({
      x: curve[segment - 1].x + (curve[segment].x - curve[segment - 1].x) * blend,
      y: curve[segment - 1].y + (curve[segment].y - curve[segment - 1].y) * blend,
    })
  }

  const normals = points.map((_, index) => {
    const ahead = points[Math.min(index + 1, count - 1)]
    const behind = points[Math.max(index - 1, 0)]
    const size = Math.hypot(ahead.x - behind.x, ahead.y - behind.y) || 1
    return { x: -(ahead.y - behind.y) / size, y: (ahead.x - behind.x) / size }
  })
  return { points, normals, length, step }
}

export function pointAlong(route: Route, distance: number): Point {
  const last = route.points.length - 1
  const position = Math.min(last, Math.max(0, distance / (route.step || 1)))
  const index = Math.min(last - 1, Math.floor(position))
  const blend = position - index
  const from = route.points[index]
  const to = route.points[index + 1]
  return { x: from.x + (to.x - from.x) * blend, y: from.y + (to.y - from.y) * blend }
}

// The conveyor stops shrinking with the camera, so the answer stays readable on a large map.
export function beltHalfWidth(zoom: number) {
  return Math.max(MIN_HALF_WIDTH, HALF_WIDTH * zoom)
}

function onScreen(point: Point, { zoom, pan }: Frame): Point {
  return { x: point.x * zoom + pan.x, y: point.y * zoom + pan.y }
}

function isVisible(path: Point[], frame: Frame, margin: number) {
  return path.some(
    (point) => point.x > -margin && point.y > -margin && point.x < frame.width + margin && point.y < frame.height + margin,
  )
}

function strokePath(context: CanvasRenderingContext2D, path: Point[], colour: string, width: number) {
  context.beginPath()
  path.forEach((point, index) => (index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)))
  context.strokeStyle = colour
  context.lineWidth = width
  context.stroke()
}

// Drawn before any belt, so every belt passes in front of every leg.
export function drawLegs(context: CanvasRenderingContext2D, route: Route, frame: Frame) {
  const { zoom } = frame
  if (zoom < DETAIL_ZOOM) return
  const belly = BELLY * zoom
  const height = LEG_HEIGHT * zoom
  const width = LEG_WIDTH * zoom
  const count = Math.floor(route.length / LEG_SPACING)
  for (let index = 1; index <= count; index += 1) {
    const { x, y } = onScreen(pointAlong(route, (route.length * index) / (count + 1)), frame)
    if (x < -width || y < -height || x > frame.width + width || y > frame.height + height) continue

    context.beginPath()
    context.ellipse(x + width, y + belly + height, width * 1.9, width * 0.6, 0, 0, Math.PI * 2)
    context.fillStyle = 'rgba(0,0,0,0.45)'
    context.fill()

    context.fillStyle = LEG_SHADE
    context.fillRect(x - width / 2, y, width, belly + height)
    context.fillStyle = LEG_SHINE
    context.fillRect(x - width / 2, y, width * 0.42, belly + height)
  }
}

export function drawConveyor(
  context: CanvasRenderingContext2D,
  route: Route,
  frame: Frame,
  flow: number,
  colour: string,
  broken: boolean,
) {
  const { zoom } = frame
  const half = beltHalfWidth(zoom)
  const path = route.points.map((point) => onScreen(point, frame))
  if (!isVisible(path, frame, half * 2 + (BELLY + LEG_HEIGHT) * zoom)) return

  const rail = Math.max(MIN_RAIL, RAIL * zoom)
  const belly = BELLY * zoom
  const side = (offset: number) =>
    path.map((point, index) => ({
      x: point.x + route.normals[index].x * offset,
      y: point.y + route.normals[index].y * offset,
    }))
  const lowered = (distance: number) => path.map((point) => ({ x: point.x, y: point.y + distance }))
  const raised = (edge: Point[]) => edge.map((point) => ({ x: point.x, y: point.y - rail * 0.3 }))

  context.save()
  context.lineJoin = 'round'
  context.lineCap = 'butt'
  if (broken) context.setLineDash(BROKEN_DASH.map((size) => size * zoom))

  strokePath(context, lowered(belly), UNDERSIDE, (half + rail) * 2)
  strokePath(context, lowered(belly / 2), UNDERSIDE, (half + rail) * 2)
  strokePath(context, path, SURFACE, half * 2)

  if (!broken) {
    const spacing = Math.max(SLAT_SPACING, MIN_SLAT_PIXELS / zoom)
    const chevron = (half * CHEVRON) / zoom
    context.beginPath()
    for (let distance = chevron + (flow % spacing); distance < route.length; distance += spacing) {
      const tip = onScreen(pointAlong(route, distance), frame)
      const tail = onScreen(pointAlong(route, distance - chevron), frame)
      const normal = route.normals[Math.round((distance - chevron) / route.step)]
      context.moveTo(tail.x + normal.x * half, tail.y + normal.y * half)
      context.lineTo(tip.x, tip.y)
      context.lineTo(tail.x - normal.x * half, tail.y - normal.y * half)
    }
    context.strokeStyle = SLAT
    context.lineWidth = Math.max(0.8, 1.1 * zoom)
    context.stroke()
  }

  for (const edge of [side(half), side(-half)]) {
    strokePath(context, edge, colour, rail + 0.6)
    if (!broken && zoom >= DETAIL_ZOOM) strokePath(context, raised(edge), RAIL_SHINE, rail * 0.5)
  }
  context.restore()
}

// The first part of a route, for a conveyor still being laid. It stops at a whole step, and the parcel covers the join.
export function sliceRoute(route: Route, reach: number): Route {
  if (reach >= 1) return route
  const count = Math.max(1, Math.floor((route.length * reach) / (route.step || 1)))
  return {
    points: route.points.slice(0, count + 1),
    normals: route.normals.slice(0, count + 1),
    length: count * route.step,
    step: route.step,
  }
}

// The packages show a line's direction, so a still map needs a mark in their place.
export function drawLine(
  context: CanvasRenderingContext2D,
  route: Route,
  frame: Frame,
  brokenColour: string | null,
  marked: boolean,
) {
  const { zoom } = frame
  const path = route.points.map((point) => onScreen(point, frame))
  if (!isVisible(path, frame, MARK_SIZE * 2)) return

  const width = Math.max(MIN_LINE_WIDTH, LINE_WIDTH * zoom)
  context.save()
  context.lineJoin = 'round'
  if (brokenColour) context.setLineDash(LINE_DASH.map((size) => size * zoom))
  strokePath(context, path, LINE_GLOW, width * 5)
  strokePath(context, path, LINE_GLOW, width * 2.6)
  strokePath(context, path, brokenColour ?? LINE, width)
  context.setLineDash([])

  if (marked) {
    const middle = route.length / 2
    const size = (MARK_SIZE * Math.max(0.7, zoom)) / zoom
    const tip = onScreen(pointAlong(route, middle + size), frame)
    const tail = onScreen(pointAlong(route, middle), frame)
    const normal = route.normals[Math.round(middle / route.step)]
    const spread = size * zoom
    context.beginPath()
    context.moveTo(tail.x + normal.x * spread, tail.y + normal.y * spread)
    context.lineTo(tip.x, tip.y)
    context.lineTo(tail.x - normal.x * spread, tail.y - normal.y * spread)
    context.stroke()
  }
  context.restore()
}

// Adds the first part of a route to the current path and returns where it stopped.
export function traceRoute(context: CanvasRenderingContext2D, route: Route, reach: number, frame: Frame): Point {
  const stop = pointAlong(route, route.length * reach)
  const end = onScreen(stop, frame)
  const start = onScreen(route.points[0], frame)
  context.moveTo(start.x, start.y)
  const steps = Math.floor((route.length * reach) / (route.step || 1))
  for (let index = 1; index <= steps; index += 1) {
    const point = onScreen(route.points[index], frame)
    context.lineTo(point.x, point.y)
  }
  context.lineTo(end.x, end.y)
  return end
}
