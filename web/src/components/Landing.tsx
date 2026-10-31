import { ArrowRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { HelixChronoMatrix } from '@/components/ui/helix-chrono-matrix'

export function Landing() {
  return (
    <HelixChronoMatrix className="h-dvh">
      <p className="mt-4 max-w-md font-mono text-sm text-white [text-shadow:0_0_3px_#090a0f,0_0_6px_#090a0f,0_0_12px_#090a0f,0_0_20px_#090a0f] md:text-base">
        Every claim the AI makes is checked against the real call graph.
      </p>
      <Button asChild size="lg" className="mt-8 font-mono">
        <a href="#/app">
          Explore the map
          <ArrowRight data-icon="inline-end" />
        </a>
      </Button>
    </HelixChronoMatrix>
  )
}
