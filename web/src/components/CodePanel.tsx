import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { fetchSource } from '@/api'
import { NodeGlyph } from '@/components/Glyphs'
import type { GraphNode } from '@/lib/run'

export const CODE_WIDTH = 580

const LINE_PADDING_PX = 72

type Source =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; html: string; quoteLost: boolean; firstLine: number }

// Prefers a match inside the node's own lines, so a repeated line doesn't highlight the wrong copy.
function findQuote(lines: string[], quote: string, start: number, end: number): number[] {
  const wanted = quote.split('\n').map((line) => line.trim())
  const matchesAt = (index: number) => wanted.every((line, offset) => lines[index + offset]?.trim().includes(line))
  const indexes = lines.map((_, index) => index).filter(matchesAt)
  const inside = indexes.find((index) => index + 1 >= start && index + 1 <= end)
  const found = inside ?? indexes[0]
  return found === undefined ? [] : wanted.map((_, offset) => found + offset + 1)
}

async function loadSource(node: GraphNode, quote: string | null): Promise<Source> {
  if (node.file === '<external>') return { kind: 'unavailable', reason: 'External code. Its source is not in this repo.' }
  let code: string
  try {
    code = (await fetchSource(node.file)).trimEnd()
  } catch (error) {
    return { kind: 'unavailable', reason: (error as Error).message }
  }
  const { highlightPython } = await import('@/lib/highlight')
  const quoted = quote ? findQuote(code.split('\n'), quote, node.line_start, node.line_end) : []
  const html = await highlightPython(code, {
    rangeStart: node.line_start,
    rangeEnd: node.line_end,
    quoted: new Set(quoted),
  })
  return { kind: 'ready', html, quoteLost: quote !== null && quoted.length === 0, firstLine: quoted[0] ?? node.line_start }
}

interface CodePanelProps {
  node: GraphNode
  colour: string
  quote: string | null
  onClose: () => void
}

export function CodePanel({ node, colour, quote, onClose }: CodePanelProps) {
  const [source, setSource] = useState<Source>({ kind: 'loading' })
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    loadSource(node, quote).then((loaded) => {
      if (!cancelled) setSource(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [node, quote])

  useEffect(() => {
    if (source.kind !== 'ready' || !scroller.current) return
    const line = scroller.current.querySelector<HTMLElement>(`[data-line="${source.firstLine}"]`)
    if (line) scroller.current.scrollTop = line.offsetTop - LINE_PADDING_PX
  }, [source])

  const lines = node.line_start > 0 ? `lines ${node.line_start}–${node.line_end}` : null

  return (
    <motion.section
      aria-label={`Source of ${node.name}`}
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="glass absolute inset-y-5 right-5 z-10 flex flex-col bg-[rgb(11_13_19/96%)]"
      style={{ width: CODE_WIDTH }}
    >
      <header className="flex items-start gap-3 border-b border-border px-5 py-3">
        <span className="mt-1.5">
          <NodeGlyph type={node.type} colour={colour} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-serif text-2xl leading-tight">{node.name}</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {node.file}
            {lines && ` · ${lines}`}
          </p>
          {node.docstring && <p className="mt-1 font-serif text-base text-foreground/80 italic">{node.docstring}</p>}
        </div>
        <button aria-label="Close code panel" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </header>
      {source.kind === 'ready' && source.quoteLost && (
        <p role="alert" className="border-b border-unverified/40 px-5 py-2 text-xs text-unverified">
          The quoted text is not in this file.
        </p>
      )}
      <div ref={scroller} className="code-plate relative flex-1 overflow-auto py-3">
        {source.kind === 'loading' && <p className="px-5 text-xs text-muted-foreground">Loading source…</p>}
        {source.kind === 'unavailable' && (
          <div className="px-5 py-2">
            <p className="kicker">Source unavailable</p>
            <p className="mt-2 text-xs text-muted-foreground">{source.reason}</p>
          </div>
        )}
        {source.kind === 'ready' && <div dangerouslySetInnerHTML={{ __html: source.html }} />}
      </div>
    </motion.section>
  )
}
