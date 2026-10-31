import { ArrowRight } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { StatusGlyph } from '@/components/Glyphs'
import { Button } from '@/components/ui/button'
import { Helix } from '@/lib/helix'
import type { Claim } from '@/types/contracts/events.schema'

const STATUSES: Claim['status'][] = ['verified', 'unverified', 'gap']

export function Landing() {
  const pageRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLCanvasElement>(null)
  const frontRef = useRef<HTMLCanvasElement>(null)
  const wordRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const page = pageRef.current
    const word = wordRef.current
    if (!page || !word || !backRef.current || !frontRef.current) return

    const helix = new Helix(backRef.current, frontRef.current)
    const measure = () => {
      const bounds = page.getBoundingClientRect()
      const box = word.getBoundingClientRect()
      helix.resize(bounds.width, bounds.height, {
        x: box.left - bounds.left + box.width / 2,
        y: box.top - bounds.top + box.height / 2,
        height: box.height,
      })
    }
    const onMove = (event: PointerEvent) => {
      const bounds = page.getBoundingClientRect()
      helix.pointAt(event.clientX - bounds.left, event.clientY - bounds.top)
    }
    const onLeave = () => helix.release()

    // The wordmark is watched too, because its box changes when the serif finishes loading.
    const observer = new ResizeObserver(measure)
    observer.observe(page)
    observer.observe(word)
    page.addEventListener('pointermove', onMove)
    page.addEventListener('pointerleave', onLeave)
    helix.start()

    return () => {
      helix.destroy()
      observer.disconnect()
      page.removeEventListener('pointermove', onMove)
      page.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return (
    <div ref={pageRef} className="relative h-dvh w-full overflow-hidden bg-background select-none">
      <canvas ref={backRef} className="absolute inset-0 size-full" aria-hidden />
      <div className="plate-vignette" />

      <main className="relative flex h-full flex-col items-center justify-center px-6 pb-12 text-center">
        <h1
          ref={wordRef}
          className="animate-in font-serif text-[length:min(36vh,31vw)] leading-[0.86] italic duration-1000 fade-in motion-reduce:animate-none"
        >
          Trace
        </h1>
        <p className="mt-[min(11vh,15vw)] max-w-md animate-in text-sm delay-700 duration-700 fill-mode-backwards fade-in slide-in-from-bottom-2 motion-reduce:animate-none md:text-base">
          Every claim the AI makes is checked against the real call graph.
        </p>
        <Button
          asChild
          size="lg"
          className="mt-6 animate-in delay-1000 duration-700 fill-mode-backwards fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
        >
          <a href="#/app">
            Explore the map
            <ArrowRight data-icon="inline-end" />
          </a>
        </Button>
      </main>

      <canvas ref={frontRef} className="pointer-events-none absolute inset-0 size-full" aria-hidden />

      <footer className="pointer-events-none absolute inset-x-6 bottom-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[10px] text-muted-foreground sm:justify-between">
        <span className="kicker">One strand is the answer. One is the code. Each rung is a claim.</span>
        <span className="flex items-center gap-4">
          {STATUSES.map((status) => (
            <span key={status} className="flex items-center gap-1.5">
              <StatusGlyph status={status} />
              {status}
            </span>
          ))}
        </span>
      </footer>
      <div className="plate-frame" />
    </div>
  )
}
