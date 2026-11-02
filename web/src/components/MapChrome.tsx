import { ArrowRight, ChevronRight, Search, X } from 'lucide-react'

import { NodeGlyph } from '@/components/Glyphs'
import { MAP_HASH } from '@/lib/route'
import type { GraphNode } from '@/lib/run'
import { cn } from '@/lib/utils'
import { useTraceStore } from '@/store'
import type { Graph } from '@/types/contracts/graph.schema'

const SHAPES: { type: GraphNode['type']; label: string }[] = [
  { type: 'route', label: 'entry point' },
  { type: 'function', label: 'function' },
  { type: 'class', label: 'class' },
  { type: 'dependency', label: 'dependency' },
  { type: 'external', label: 'outside library' },
  { type: 'unresolved', label: 'unknown target' },
]

interface TopBarProps {
  graph: Graph
  moduleName: string | null
  file: string | null
}

export function TopBar({ graph, moduleName, file }: TopBarProps) {
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
        {file && (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs">
            <a href={MAP_HASH} className="text-muted-foreground transition-colors hover:text-foreground">
              back to map
            </a>
            <ChevronRight className="size-3 text-muted-foreground" />
            <span className="text-primary">{file}</span>
          </nav>
        )}
        {moduleName && !file && (
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

interface PinnedLineChipProps {
  from: string
  to: string
  rightInset: number
  onClear: () => void
}

export function PinnedLineChip({ from, to, rightInset, onClear }: PinnedLineChipProps) {
  return (
    <div
      className="pointer-events-none absolute top-16 left-7 flex justify-center transition-[right] duration-300"
      style={{ right: rightInset }}
    >
      <div className="glass pointer-events-auto flex items-center gap-2 border-primary/60 py-1 pr-1 pl-3 text-xs">
        <span>{from}</span>
        <ArrowRight aria-hidden className="size-3.5 text-primary" />
        <span>{to}</span>
        <button
          onClick={onClear}
          className="ml-1 flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <X aria-hidden className="size-3.5" />
          Unselect
          <kbd className="border border-border px-1 text-[10px]">esc</kbd>
        </button>
      </div>
    </div>
  )
}

interface ToggleProps {
  on: boolean
  disabled?: boolean
  onClick: () => void
  label: string
}

function Toggle({ on, disabled = false, onClick, label }: ToggleProps) {
  return (
    <button
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'glass shrink-0 px-2.5 py-1.5 transition-colors hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground',
        on && 'border-primary/60 text-foreground',
      )}
    >
      {on ? 'Hide' : 'Show'} {label}
    </button>
  )
}

function Sample({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('w-5', className)} />
      {label}
    </span>
  )
}

interface LegendProps {
  graph: Graph
  rightInset: number
  hint: boolean
}

export function Legend({ graph, rightInset, hint }: LegendProps) {
  const { stats } = graph
  const showWiring = useTraceStore((state) => state.showWiring)
  const setShowWiring = useTraceStore((state) => state.setShowWiring)
  const showCallLines = useTraceStore((state) => state.showCallLines)
  const setShowCallLines = useTraceStore((state) => state.setShowCallLines)
  const internalCalls = stats.calls_resolved + stats.calls_uncertain
  return (
    <footer
      className="absolute bottom-5 left-7 flex items-center gap-4 overflow-hidden text-[10px] whitespace-nowrap text-muted-foreground transition-[right] duration-300"
      style={{ right: rightInset }}
    >
      <Toggle
        on={showCallLines || showWiring}
        disabled={showWiring}
        onClick={() => setShowCallLines(!showCallLines)}
        label="call lines"
      />
      <Toggle on={showWiring} onClick={() => setShowWiring(!showWiring)} label="all connections" />
      <div className="glass flex items-center gap-4 px-3 py-1.5">
        {SHAPES.filter(({ type }) => (stats.nodes_by_type[type] ?? 0) > 0).map(({ type, label }) => (
          <span key={type} className="flex items-center gap-1.5">
            <NodeGlyph type={type} />
            {label}
          </span>
        ))}
        <span className="h-3 border-l border-border" />
        <Sample className="line-sample" label="calls" />
        <Sample className="border-t-2 border-dashed border-gap" label="uncertain" />
        <Sample className="belt-sample" label="the answer" />
      </div>
      <span className="ml-auto">
        {hint && 'Hover a node · click a line · '}
        {stats.calls_resolved}/{internalCalls} internal calls resolved · externals by rule
      </span>
    </footer>
  )
}
