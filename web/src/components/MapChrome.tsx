import { ArrowRight, ChevronRight, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { NodeGlyph } from '@/components/Glyphs'
import { MAP_HASH, REPOS_HASH } from '@/lib/route'
import type { GraphNode, RunView } from '@/lib/run'
import { cn } from '@/lib/utils'
import { useTraceStore } from '@/store'
import type { Graph } from '@/types/contracts/graph.schema'

const SHAPES: { type: GraphNode['type']; label: string }[] = [
  { type: 'route', label: 'entry point' },
  { type: 'function', label: 'function' },
  { type: 'class', label: 'class' },
  { type: 'dependency', label: 'dependency' },
  { type: 'external', label: 'library' },
  { type: 'unresolved', label: 'unknown' },
]

export function Mark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 text-primary" aria-hidden>
      <circle cx="3" cy="4" r="2" fill="currentColor" />
      <circle cx="13" cy="8" r="2" fill="currentColor" />
      <circle cx="5" cy="13" r="2" fill="currentColor" />
      <path d="M4.6 4.8 11.4 7.4M11.4 8.8 6.6 12.2" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  )
}

function RunBadge({ run, recorded }: { run: RunView; recorded: boolean }) {
  if (run.phase === 'idle') return null
  const running = run.phase === 'walking' || run.phase === 'revealing'
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]',
        recorded ? 'border-border text-muted-foreground' : 'border-verified/40 text-verified',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          recorded ? 'bg-muted-foreground' : 'bg-verified',
          running && 'animate-pulse motion-reduce:animate-none',
        )}
      />
      {recorded ? 'Recorded run' : 'Live run'}
      {run.error ? ' · stopped' : running ? '' : ' · done'}
    </span>
  )
}

interface TitleBarProps {
  graph: Graph
  moduleName: string | null
  file: string | null
  run: RunView
  recorded: boolean
}

export function TitleBar({ graph, moduleName, file, run, recorded }: TitleBarProps) {
  const exitModule = useTraceStore((state) => state.exitModule)
  const setPaletteOpen = useTraceStore((state) => state.setPaletteOpen)
  const sidebarOpen = useTraceStore((state) => state.sidebarOpen)
  const setSidebarOpen = useTraceStore((state) => state.setSidebarOpen)
  const place = file ?? moduleName

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-card pr-3 pl-1.5">
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-pressed={sidebarOpen}
        aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        title={`${sidebarOpen ? 'Hide' : 'Show'} sidebar (⌘B)`}
        className="grid size-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {sidebarOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
      </button>
      <a href="#/" className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
        <Mark />
        Trace
      </a>
      <span className="h-4 border-l border-border" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 basis-0 items-center gap-1 font-mono text-xs">
        <a
          href={REPOS_HASH}
          title="Switch repository"
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          Repositories
        </a>
        <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <a
          href={MAP_HASH}
          onClick={() => !file && exitModule()}
          title={`${graph.repo} @ ${graph.commit_sha.slice(0, 7)}`}
          className={cn(
            'min-w-8 shrink-[4] truncate transition-colors hover:text-foreground',
            place ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {graph.repo}
          {!place && <span className="text-muted-foreground"> @ {graph.commit_sha.slice(0, 7)}</span>}
        </a>
        {place && (
          <>
            <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <span title={place} className="min-w-0 truncate text-foreground">
              {place}
            </span>
          </>
        )}
      </nav>
      <button
        onClick={() => setPaletteOpen(true)}
        className="flex w-80 shrink-0 items-center gap-2 rounded border border-input bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
      >
        <Search aria-hidden className="size-3.5" />
        Search functions, classes, routes
        <kbd className="ml-auto rounded-sm border border-border px-1 font-mono text-[10px]">⌘K</kbd>
      </button>
      <div className="flex flex-1 basis-0 justify-end">
        <RunBadge run={run} recorded={recorded} />
      </div>
    </header>
  )
}

interface Health {
  model: string
  live: boolean
}

function useHealth(): Health | null {
  const [health, setHealth] = useState<Health | null>(null)
  useEffect(() => {
    fetch('/api/health')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => body && setHealth({ model: body.model ?? '', live: body.live === true }))
      .catch(() => setHealth(null))
  }, [])
  return health
}

function Sample({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('w-4', className)} />
      {label}
    </span>
  )
}

export function StatusBar({ graph }: { graph: Graph }) {
  const health = useHealth()
  const { stats } = graph
  const internalCalls = stats.calls_resolved + stats.calls_uncertain
  const live = health?.live ?? false

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-card px-3 text-[11px] whitespace-nowrap text-muted-foreground">
      <span
        className="flex items-center gap-1.5"
        title={live ? 'Typed questions run live' : 'No model key, so only recorded questions can run'}
      >
        <span className={cn('size-1.5 rounded-full', live ? 'bg-verified' : 'bg-muted-foreground')} />
        <span className="font-mono">{health?.model || 'no model set'}</span>
        {health && !live && <span>· recorded runs only</span>}
      </span>
      <span className="font-mono tabular-nums">
        {graph.nodes.length} nodes · {graph.edges.length} edges · {stats.calls_resolved}/{internalCalls} calls resolved
      </span>
      <span className="ml-auto flex items-center gap-3">
        {SHAPES.filter(({ type }) => (stats.nodes_by_type[type] ?? 0) > 0).map(({ type, label }) => (
          <span key={type} className="flex items-center gap-1">
            <NodeGlyph type={type} />
            {label}
          </span>
        ))}
        <span className="h-3 border-l border-border" />
        <Sample className="line-sample" label="call" />
        <Sample className="border-t-2 border-dashed border-gap" label="unproven" />
        <Sample className="belt-sample" label="answer" />
      </span>
    </footer>
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
        'flex items-center gap-1.5 rounded-[3px] px-2 py-1 transition-colors disabled:opacity-50',
        on ? 'bg-accent text-foreground' : 'text-muted-foreground enabled:hover:text-foreground',
      )}
    >
      <span className={cn('size-2 rounded-full border', on ? 'border-primary bg-primary' : 'border-muted-foreground')} />
      {label}
    </button>
  )
}

// View options over the top left of the map.
export function MapToolbar({ hint }: { hint: boolean }) {
  const showWiring = useTraceStore((state) => state.showWiring)
  const setShowWiring = useTraceStore((state) => state.setShowWiring)
  const showCallLines = useTraceStore((state) => state.showCallLines)
  const setShowCallLines = useTraceStore((state) => state.setShowCallLines)
  return (
    <div className="absolute top-3 left-3 flex items-center gap-3 text-[11px]">
      <div className="glass flex items-center gap-0.5 p-0.5 shadow-none">
        <Toggle
          on={showCallLines || showWiring}
          disabled={showWiring}
          onClick={() => setShowCallLines(!showCallLines)}
          label="Call lines"
        />
        <Toggle on={showWiring} onClick={() => setShowWiring(!showWiring)} label="All connections" />
      </div>
      {hint && <span className="text-muted-foreground">Hover a node to see its calls · click a line to pin it</span>}
    </div>
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
      className="pointer-events-none absolute top-12 left-3 flex justify-center transition-[right] duration-300"
      style={{ right: rightInset }}
    >
      <div className="glass pointer-events-auto flex items-center gap-2 border-primary/60 py-1 pr-1 pl-3 font-mono text-xs">
        <span>{from}</span>
        <ArrowRight aria-hidden className="size-3.5 text-primary" />
        <span>{to}</span>
        <button
          onClick={onClear}
          className="ml-1 flex items-center gap-1.5 px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <X aria-hidden className="size-3.5" />
          Unselect
          <kbd className="rounded-sm border border-border px-1 text-[10px]">esc</kbd>
        </button>
      </div>
    </div>
  )
}
