import { ChevronRight, Search } from 'lucide-react'

import { NodeGlyph } from '@/components/Glyphs'
import type { GraphNode } from '@/lib/run'
import { useTraceStore } from '@/store'
import type { Graph } from '@/types/contracts/graph.schema'

const LEGEND: GraphNode['type'][] = ['route', 'function', 'class', 'dependency', 'external']

export function TopBar({ graph, moduleName }: { graph: Graph; moduleName: string | null }) {
  const exitModule = useTraceStore((state) => state.exitModule)
  const setPaletteOpen = useTraceStore((state) => state.setPaletteOpen)

  return (
    <>
      <header className="absolute top-6 left-7 flex items-baseline gap-3">
        <a href="#/" className="font-serif text-3xl leading-none italic">
          Trace
        </a>
        <span className="text-xs text-muted-foreground">
          {graph.repo} @ {graph.commit_sha.slice(0, 7)}
        </span>
        {moduleName && (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs">
            <button onClick={exitModule} className="text-muted-foreground transition-colors hover:text-foreground">
              all modules
            </button>
            <ChevronRight className="size-3 text-muted-foreground" />
            <span className="text-primary">{moduleName}</span>
          </nav>
        )}
      </header>
      <button
        onClick={() => setPaletteOpen(true)}
        className="glass absolute top-6 right-7 flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Search className="size-3.5" />
        Jump to
        <kbd className="border border-border px-1 text-[10px]">/</kbd>
      </button>
    </>
  )
}

export function Legend({ graph, rightInset }: { graph: Graph; rightInset: number }) {
  const { stats } = graph
  const objects = graph.nodes.length - (stats.nodes_by_type.module ?? 0)
  const resolved = stats.call_resolution_rate
  return (
    <footer
      className="absolute bottom-5 left-7 flex items-center gap-4 overflow-hidden text-[10px] whitespace-nowrap text-muted-foreground transition-[right] duration-300"
      style={{ right: rightInset }}
    >
      {LEGEND.map((type) => (
        <span key={type} className="flex items-center gap-1.5">
          <NodeGlyph type={type} />
          {type}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="w-4 border-t border-dashed border-gap" />
        uncertain
      </span>
      <span className="ml-auto">
        {objects} objects{resolved !== null && ` · ${Math.round(resolved * 100)}% of calls resolved`} ·{' '}
        {stats.calls_uncertain} uncertain
      </span>
    </footer>
  )
}
