import type { Frame } from '@/lib/pills'
import type { Point } from '@/lib/scene'

// Routes between nodes and the quiet line a call is drawn as. The answer's path over the same route is drawn in sky.ts.
// A route is sampled at even steps, in model units, so a distance along it is an array lookup.

const BEND = 0.55
const LEAVE_RATIO = 0.45
const CURVE_SAMPLES = 48
const ROUTE_STEP = 8

const LINE_WIDTH = 1.5
const MIN_LINE_WIDTH = 1
const LINE_DASH = [7, 6]
const MARK_SIZE = 5

const LINE = '#5b6270'

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

// Lines leave and arrive along their longer axis, which gives smooth S-bends instead of diagonals.
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

// How far a point on the map is from a route. Routes are sampled every few units, so the nearest sample is close enough.
export function distanceToRoute(route: Route, point: Point): number {
  return Math.min(...route.points.map((sample) => Math.hypot(sample.x - point.x, sample.y - point.y)))
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

// Every line carries a small arrowhead halfway along, so its direction reads in a still frame.
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
