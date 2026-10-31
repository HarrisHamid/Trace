// Adapted from the third-party HelixChronoMatrix component. See the Attribution section of README.md.
import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

const RING_COUNT = 28
const POINTS_PER_RING = 120
const PARTICLE_COUNT = 45
const BACKGROUND = '#090a0f'

// The shape is tuned for a 600px canvas. Larger canvases scale the camera and wave with it, because
// the ring radius grows with the viewport and would otherwise reach the camera and blow up the projection.
const REFERENCE_SIZE = 600
const BASE_FOV = 600
const BASE_CAMERA_DIST = 550
const BASE_WAVE_HEIGHT = 45

interface FiberPoint {
  vy: number
  excitation: number
}

interface FiberRing {
  points: FiberPoint[]
  radius: number
  yOffset: number
  rotationSpeed: number
  angle: number
  harmonicOffset: number
}

interface Particle {
  ringIndex: number
  progress: number // 0 to 1 along the ring
  speed: number
  size: number
}

export interface HelixChronoMatrixProps {
  headline?: string
  className?: string
  children?: ReactNode
}

function createRings(width: number, height: number): FiberRing[] {
  return Array.from({ length: RING_COUNT }, (_, r) => {
    const progress = r / RING_COUNT
    return {
      points: Array.from({ length: POINTS_PER_RING }, () => ({ vy: 0, excitation: 0 })),
      radius: Math.min(width, height) * 0.35 * (0.4 + progress * 0.6),
      yOffset: (progress - 0.5) * (height * 0.45),
      rotationSpeed: (r % 2 === 0 ? 1 : -1) * (0.002 + progress * 0.0025),
      angle: (r * Math.PI) / RING_COUNT,
      harmonicOffset: r * 0.2,
    }
  })
}

function createParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, () => ({
    ringIndex: Math.floor(Math.random() * RING_COUNT),
    progress: Math.random(),
    speed: (Math.random() * 0.003 + 0.001) * (Math.random() > 0.5 ? 1 : -1),
    size: Math.random() * 1.5 + 1.5,
  }))
}

export function HelixChronoMatrix({ headline = 'TRACE', className, children }: HelixChronoMatrixProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pointerRef = useRef({ x: -2000, y: -2000, targetX: -2000, targetY: -2000, radius: 220 })

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d', { alpha: false })
    if (!container || !canvas || !ctx) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const pointer = pointerRef.current
    let rings: FiberRing[] = []
    let particles: Particle[] = []
    let size = { width: 0, height: 0 }
    let animId = 0
    let time = 0

    const draw = () => {
      time += 0.012
      const { width, height } = size

      // Silky smooth mouse interpolation (Lerp)
      pointer.x += (pointer.targetX - pointer.x) * 0.1
      pointer.y += (pointer.targetY - pointer.y) * 0.1

      ctx.fillStyle = BACKGROUND
      ctx.fillRect(0, 0, width, height)

      const centerX = width / 2
      const centerY = height / 2
      const sizeScale = Math.max(1, Math.min(width, height) / REFERENCE_SIZE)
      const fov = BASE_FOV * sizeScale
      const cameraDist = BASE_CAMERA_DIST * sizeScale
      const waveHeight = BASE_WAVE_HEIGHT * sizeScale

      // Render fibers
      rings.forEach((ring, rIdx) => {
        ring.angle += ring.rotationSpeed

        ctx.beginPath()
        let firstProjX = 0
        let firstProjY = 0
        let avgExcitation = 0

        ring.points.forEach((pt, pIdx) => {
          const theta = (pIdx / POINTS_PER_RING) * Math.PI * 2 + ring.angle
          const x3D = Math.cos(theta) * ring.radius
          const z3D = Math.sin(theta) * ring.radius
          const y3D = ring.yOffset + Math.sin(theta * 2 + time * 2 + ring.harmonicOffset) * waveHeight

          const scale = fov / (cameraDist + z3D)
          const projX = centerX + x3D * scale
          const projY = centerY + (y3D + pt.vy) * scale

          // Smooth pointer attraction field
          const dist = Math.hypot(projX - pointer.x, projY - pointer.y)
          if (dist < pointer.radius && dist > 0) {
            const ratio = 1 - dist / pointer.radius
            const targetVy = Math.sin(theta + time) * ratio * 15
            pt.vy += (targetVy - pt.vy) * 0.1
            pt.excitation = Math.max(pt.excitation, ratio)
          } else {
            pt.vy *= 0.92
          }

          pt.excitation *= 0.92
          avgExcitation += pt.excitation

          if (pIdx === 0) {
            firstProjX = projX
            firstProjY = projY
            ctx.moveTo(projX, projY)
          } else {
            ctx.lineTo(projX, projY)
          }
        })

        ctx.lineTo(firstProjX, firstProjY)

        avgExcitation /= POINTS_PER_RING
        const depthAlpha = 0.3 + (rIdx / rings.length) * 0.25

        if (avgExcitation > 0.05) {
          ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1, 0.4 + avgExcitation * 0.6)})`
          ctx.lineWidth = 1.2 + avgExcitation * 1.5
        } else {
          ctx.strokeStyle = `rgba(255, 255, 255, ${depthAlpha})`
          ctx.lineWidth = 1
        }

        ctx.stroke()
      })

      // Render traveling points: black normally, white when near the pointer
      for (const p of particles) {
        p.progress = (p.progress + p.speed + 1) % 1

        const ring = rings[p.ringIndex]
        if (!ring) continue

        const exactIndex = p.progress * POINTS_PER_RING
        const pIdx1 = Math.floor(exactIndex) % POINTS_PER_RING
        const pIdx2 = (pIdx1 + 1) % POINTS_PER_RING
        const blend = exactIndex - Math.floor(exactIndex)

        const theta1 = (pIdx1 / POINTS_PER_RING) * Math.PI * 2 + ring.angle
        const theta2 = (pIdx2 / POINTS_PER_RING) * Math.PI * 2 + ring.angle

        const x1 = Math.cos(theta1) * ring.radius
        const z1 = Math.sin(theta1) * ring.radius
        const x2 = Math.cos(theta2) * ring.radius
        const z2 = Math.sin(theta2) * ring.radius

        const x3D = x1 + (x2 - x1) * blend
        const z3D = z1 + (z2 - z1) * blend

        const scale = fov / (cameraDist + z3D)
        const projX = centerX + x3D * scale
        const projY = centerY + ring.yOffset * scale

        ctx.beginPath()
        ctx.arc(projX, projY, p.size * scale, 0, Math.PI * 2)
        ctx.fillStyle = Math.hypot(projX - pointer.x, projY - pointer.y) < pointer.radius ? '#ffffff' : '#000000'
        ctx.fill()

        ctx.lineWidth = 0.5
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'
        ctx.stroke()
      }
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        const dpr = Math.min(window.devicePixelRatio || 1, 2)

        size = { width, height }
        canvas.width = Math.floor(width * dpr)
        canvas.height = Math.floor(height * dpr)

        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.scale(dpr, dpr)
        rings = createRings(width, height)
        particles = createParticles()
        // Resizing clears the canvas, and with reduced motion this is the only frame drawn
        draw()
      }
    })
    resizeObserver.observe(container)

    const loop = () => {
      draw()
      animId = requestAnimationFrame(loop)
    }
    if (!reducedMotion) animId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(animId)
      resizeObserver.disconnect()
    }
  }, [])

  const handlePointerMove = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    pointerRef.current.targetX = event.clientX - rect.left
    pointerRef.current.targetY = event.clientY - rect.top
  }

  const handlePointerLeave = () => {
    pointerRef.current.targetX = -2000
    pointerRef.current.targetY = -2000
  }

  return (
    <div
      ref={containerRef}
      onMouseMove={handlePointerMove}
      onMouseLeave={handlePointerLeave}
      className={cn('relative h-full w-full select-none overflow-hidden bg-[#090a0f]', className)}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full cursor-crosshair" />

      <main className="pointer-events-none relative z-20 flex h-full w-full flex-col items-center justify-center p-6 text-center md:p-10">
        <h1 className="font-mono text-[length:min(22vh,18vw)] leading-none font-black tracking-tighter text-white/90 uppercase">
          {headline}
        </h1>
        {children && <div className="pointer-events-auto">{children}</div>}
      </main>
    </div>
  )
}
