import { animate, motion, useMotionValue, useTransform, type MotionValue } from 'framer-motion'
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent, type Ref } from 'react'

import { fetchSource } from '@/api'
import { NodeGlyph } from '@/components/Glyphs'
import {
  blockForNode,
  boundsOf,
  buildBlockPage,
  CARD_HEADER,
  CARD_ROW,
  CODE_PADDING,
  HEADER_HEIGHT,
  LINE_HEIGHT,
  type Arrow,
  type Block,
  type BlockPage,
  type Bounds,
  type CallerCard,
} from '@/lib/fileblocks'
import { EXTERNAL_FILE, type FileGraph } from '@/lib/filegraph'
import type { CodeToken } from '@/lib/highlight'
import type { GraphNode } from '@/lib/run'
import { cn } from '@/lib/utils'
import { useTraceStore } from '@/store'

// One file taken apart. It opens as the plain file, boxes and titles land on each function, the blocks move out into a graph,
// and the arrows draw in, each leaving from the line that makes the call.

export interface FileCamera {
  reveal: () => void
  conceal: () => void
  replay: () => void
}

type Stage = 'page' | 'boxed' | 'graph' | 'wired'

const INSETS = { top: 76, right: 32, bottom: 72, left: 32 }
const MAX_ZOOM = 1.05
const MIN_ZOOM = 0.1
const WHEEL_SPEED = 0.0016
const DRAG_THRESHOLD = 4
const HOLD_PAGE_MS = 450
const BOX_STAGGER_MS = 45
const BOXES_MIN_MS = 500
const BOXES_MAX_MS = 1100
const SPREAD_MS = 950
const FOCUS_SECONDS = 0.6
const FOCUS_PADDING = 24
const CAMERA_EASE = [0.22, 1, 0.36, 1] as const
const SPRING = { type: 'spring', stiffness: 90, damping: 18 } as const

type Tokens = Map<string, CodeToken[][]>

interface Loaded {
  built: BlockPage
  tokens: Tokens
}

async function readFile(file: string) {
  const text = (await fetchSource(file)).trimEnd()
  const { highlightLines } = await import('@/lib/highlight')
  return { file, lines: text.split('\n'), tokens: await highlightLines(text) }
}

async function load(page: FileGraph): Promise<Loaded> {
  const others = new Set(
    page.graph.nodes
      .map((node) => node.file)
      .filter((file) => file !== page.file && file !== EXTERNAL_FILE),
  )
  const own = await readFile(page.file)
  const read = await Promise.allSettled([...others].map(readFile))
  const files = [own, ...read.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))]
  return {
    built: buildBlockPage(page, new Map(files.map(({ file, lines }) => [file, lines]))),
    tokens: new Map(files.map(({ file, tokens }) => [file, tokens])),
  }
}

function CodeLine({ tokens, marked }: { tokens: CodeToken[] | undefined; marked: boolean }) {
  return (
    <div className={cn('whitespace-pre', marked && 'bg-foreground/10')} style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}>
      {tokens?.map((token, index) => (
        <span key={index} style={{ color: token.colour, fontStyle: token.italic ? 'italic' : undefined }}>
          {token.text}
        </span>
      ))}
    </div>
  )
}

interface BlockCardProps {
  block: Block
  order: number
  stage: Stage
  colour: string
  tokens: CodeToken[][] | undefined
  glyph: GraphNode['type'] | null
  dimmed: boolean
  chosen: boolean
  lit: boolean
  markedLines: Set<number>
  onChoose: () => void
  onHover: (on: boolean) => void
  onOpenFile: () => void
}

function BlockCard({ block, order, stage, colour, tokens, glyph, dimmed, chosen, lit, markedLines, onChoose, onHover, onOpenFile }: BlockCardProps) {
  const foreign = block.kind === 'foreign' || block.kind === 'unknown'
  const spread = stage === 'graph' || stage === 'wired'
  const boxed = stage !== 'page'
  const lineCount = block.end - block.start + 1
  const lines = Array.from({ length: Math.max(0, lineCount) }, (_, index) => block.start + index)
  const opacity = foreign && stage !== 'wired' ? 0 : dimmed ? 0.28 : 1

  return (
    <motion.article
      initial={false}
      animate={{ x: spread ? block.x : 0, y: spread ? block.y : block.stackY, opacity }}
      transition={{ x: { ...SPRING, delay: spread ? order * 0.03 : 0 }, y: { ...SPRING, delay: spread ? order * 0.03 : 0 }, opacity: { duration: 0.3 } }}
      onClick={(event) => {
        event.stopPropagation()
        onChoose()
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      aria-label={`${block.title}, ${block.kicker}`}
      className="absolute top-0 left-0 cursor-pointer overflow-hidden rounded-lg"
      style={{
        width: block.width,
        height: block.height,
        pointerEvents: foreign && stage !== 'wired' ? 'none' : undefined,
        border: `1px ${block.kind === 'unknown' ? 'dashed' : 'solid'} ${boxed ? (chosen ? 'var(--foreground)' : lit ? 'rgb(196 206 232 / 55%)' : 'rgb(196 206 232 / 18%)') : 'transparent'}`,
        background: boxed ? 'linear-gradient(180deg, rgb(27 31 44 / 96%), rgb(15 17 26 / 96%))' : 'transparent',
        boxShadow: boxed && spread ? '0 10px 24px rgb(0 0 0 / 40%)' : 'none',
        transition: 'border-color 240ms, background 320ms, box-shadow 320ms',
        transitionDelay: stage === 'boxed' ? `${order * BOX_STAGGER_MS}ms` : '0ms',
      }}
    >
      <header
        className="flex items-center gap-2.5 border-b px-3.5"
        style={{
          height: HEADER_HEIGHT,
          borderColor: boxed ? 'rgb(196 206 232 / 12%)' : 'transparent',
          boxShadow: boxed ? `inset 0 2px 0 ${colour}` : 'none',
          opacity: boxed ? 1 : 0,
          transition: 'opacity 280ms',
          transitionDelay: stage === 'boxed' ? `${order * BOX_STAGGER_MS}ms` : '0ms',
        }}
      >
        {glyph && <NodeGlyph type={glyph} colour={colour} />}
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-serif text-xl leading-tight text-foreground">{block.title}</h3>
          <p className="truncate text-[10px] text-muted-foreground">
            {block.kicker}
            {block.kind !== 'unknown' && lineCount > 0 && ` · lines ${block.start}–${block.end + block.clipped}`}
          </p>
        </div>
        {block.outside.length > 0 && (
          <p
            title={`Calls outside this repo: ${block.outside.join(', ')}`}
            className="max-w-[45%] truncate text-right text-[10px] text-muted-foreground"
          >
            uses {block.outside.slice(0, 2).join(', ')}
            {block.outside.length > 2 && ` +${block.outside.length - 2}`}
          </p>
        )}
        {block.kind === 'foreign' && (
          <button
            onClick={(event) => {
              event.stopPropagation()
              onOpenFile()
            }}
            className="shrink-0 border border-border px-1.5 py-0.5 text-[10px] text-primary transition-colors hover:border-primary/60 hover:text-foreground"
          >
            Graphify
          </button>
        )}
      </header>
      {lines.length > 0 && (
        <div className="relative overflow-hidden font-mono text-xs" style={{ padding: `${CODE_PADDING}px 14px` }}>
          {lines.map((line) => (
            <CodeLine key={line} tokens={tokens?.[line - 1]} marked={!foreign && markedLines.has(line)} />
          ))}
          {block.clipped > 0 && (
            <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0f111a] to-transparent px-3.5 pt-5 pb-1.5 text-[10px] text-muted-foreground">
              {block.clipped} more lines
            </p>
          )}
        </div>
      )}
    </motion.article>
  )
}

function CallersCard({ card, shown, dimmed, chosen, onChoose, onOpen }: { card: CallerCard; shown: boolean; dimmed: boolean; chosen: boolean; onChoose: () => void; onOpen: (nodeId: string) => void }) {
  return (
    <motion.section
      initial={false}
      animate={{ opacity: shown ? (dimmed ? 0.28 : 1) : 0 }}
      transition={{ duration: 0.35 }}
      onClick={(event) => {
        event.stopPropagation()
        onChoose()
      }}
      className="absolute cursor-pointer overflow-hidden rounded-lg"
      style={{
        left: card.x,
        top: card.y,
        width: card.width,
        height: card.height,
        pointerEvents: shown ? undefined : 'none',
        border: `1px solid ${chosen ? 'var(--foreground)' : 'rgb(196 206 232 / 18%)'}`,
        background: 'rgb(15 17 26 / 92%)',
      }}
    >
      <header className="flex items-center px-3.5" style={{ height: CARD_HEADER }}>
        <div className="min-w-0">
          <p className="kicker">Called from</p>
          <p className="truncate text-[11px] text-foreground">{card.file}</p>
        </div>
      </header>
      {card.rows.map((row) => (
        <button
          key={`${row.nodeId}>${row.target}`}
          onClick={(event) => {
            event.stopPropagation()
            onOpen(row.nodeId)
          }}
          className="block w-full truncate px-3.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          style={{ height: CARD_ROW, lineHeight: `${CARD_ROW}px` }}
        >
          {row.name}
        </button>
      ))}
    </motion.section>
  )
}

function ArrowLine({ arrow, stage, order, lit, dimmed, stroke }: { arrow: Arrow; stage: Stage; order: number; lit: boolean; dimmed: boolean; stroke: MotionValue<number> }) {
  const shown = stage === 'wired'
  const drawn = arrow.kind === 'call' && !arrow.broken
  const opacity = !shown ? 0 : dimmed ? 0.1 : lit ? 1 : 0.62
  const colour = arrow.broken ? 'var(--status-gap)' : 'var(--foreground)'
  return (
    <motion.path
      d={arrow.path}
      fill="none"
      stroke={colour}
      markerEnd={arrow.broken ? 'url(#arrow-broken)' : 'url(#arrow)'}
      strokeDasharray={drawn ? undefined : arrow.broken ? '7 6' : '2 6'}
      initial={false}
      animate={drawn ? { pathLength: shown ? 1 : 0, opacity } : { opacity }}
      transition={{ pathLength: { duration: 0.55, delay: shown ? order * 0.05 : 0, ease: 'easeInOut' }, opacity: { duration: 0.2, delay: shown && !lit && !dimmed ? order * 0.05 : 0 } }}
      style={{ strokeWidth: stroke }}
    />
  )
}

interface FileBlocksProps {
  page: FileGraph
  colourOf: (node: GraphNode) => string
  animated: boolean
  camera: Ref<FileCamera>
  onOpenFile: (file: string, nodeId: string) => void
}

export function FileBlocks({ page, colourOf, animated, camera, onOpenFile }: FileBlocksProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [stage, setStage] = useState<Stage>(animated ? 'page' : 'wired')
  const [chosen, setChosen] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const timers = useRef<number[]>([])
  const wanted = useRef(false)
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null)
  const selectedNode = useTraceStore((state) => state.selectedNode)
  const selectNode = useTraceStore((state) => state.selectNode)
  const panX = useMotionValue(0)
  const panY = useMotionValue(0)
  const zoom = useMotionValue(1)
  const stroke = useTransform(zoom, (value) => Math.max(1.5, 1.5 / value))
  const nodes = useMemo(() => new Map(page.graph.nodes.map((node) => [node.id, node])), [page])

  const moveTo = useCallback(
    (bounds: Bounds, duration: number, padding = 0) => {
      const element = frame.current
      if (!element) return
      const width = element.clientWidth - INSETS.left - INSETS.right - padding * 2
      const height = element.clientHeight - INSETS.top - INSETS.bottom - padding * 2
      const boxWidth = bounds.x2 - bounds.x1
      const boxHeight = bounds.y2 - bounds.y1
      const scale = Math.min(width / boxWidth, height / boxHeight, MAX_ZOOM)
      const x = INSETS.left + padding + (width - boxWidth * scale) / 2 - bounds.x1 * scale
      const y = INSETS.top + padding + (height - boxHeight * scale) / 2 - bounds.y1 * scale
      for (const [value, target] of [[panX, x], [panY, y], [zoom, scale]] as const) {
        if (duration === 0) value.set(target)
        else animate(value, target, { duration, ease: CAMERA_EASE })
      }
    },
    [panX, panY, zoom],
  )

  const clearTimers = () => {
    timers.current.forEach((timer) => window.clearTimeout(timer))
    timers.current = []
  }

  const play = useCallback(
    (built: BlockPage) => {
      clearTimers()
      setChosen(null)
      setStage('page')
      moveTo(built.stackBounds, 0)
      const own = built.blocks.filter((block) => block.file === page.file).length
      const boxes = Math.min(BOXES_MAX_MS, Math.max(BOXES_MIN_MS, own * BOX_STAGGER_MS + 300))
      const after = (delay: number, action: () => void) => timers.current.push(window.setTimeout(action, delay))
      after(HOLD_PAGE_MS, () => setStage('boxed'))
      after(HOLD_PAGE_MS + boxes, () => {
        setStage('graph')
        moveTo(built.bounds, SPREAD_MS / 1000)
      })
      after(HOLD_PAGE_MS + boxes + SPREAD_MS * 0.8, () => setStage('wired'))
    },
    [moveTo, page.file],
  )

  useEffect(() => clearTimers, [])

  useEffect(() => {
    let cancelled = false
    load(page).then(
      (result) => {
        if (cancelled) return
        setLoaded(result)
        if (wanted.current) play(result.built)
        else moveTo(animated ? result.built.stackBounds : result.built.bounds, 0)
      },
      () => {
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [page, animated, moveTo, play])

  useImperativeHandle(
    camera,
    () => ({
      reveal() {
        if (loaded) play(loaded.built)
        else wanted.current = true
      },
      conceal() {
        clearTimers()
        setStage('page')
        if (loaded) moveTo(loaded.built.stackBounds, 0.4)
      },
      replay() {
        if (loaded) play(loaded.built)
      },
    }),
    [loaded, moveTo, play],
  )

  useEffect(() => {
    const element = frame.current
    if (!element) return
    function onWheel(event: WheelEvent) {
      event.preventDefault()
      const box = element!.getBoundingClientRect()
      const scale = Math.min(MAX_ZOOM * 2, Math.max(MIN_ZOOM, zoom.get() * Math.exp(-event.deltaY * WHEEL_SPEED)))
      const ratio = scale / zoom.get()
      const x = event.clientX - box.left
      const y = event.clientY - box.top
      panX.set(x - (x - panX.get()) * ratio)
      panY.set(y - (y - panY.get()) * ratio)
      zoom.set(scale)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [panX, panY, zoom])

  function onPointerDown(event: PointerEvent) {
    drag.current = { x: event.clientX, y: event.clientY, panX: panX.get(), panY: panY.get(), moved: false }
  }

  function onPointerMove(event: PointerEvent) {
    const start = drag.current
    if (!start || event.buttons !== 1) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) start.moved = true
    if (!start.moved) return
    panX.set(start.panX + dx)
    panY.set(start.panY + dy)
  }

  // A drag that ends over a block must not count as a click on it.
  const dragged = () => drag.current?.moved ?? false
  const built = loaded?.built
  // The block the map, the palette or a neighbouring file sent us to stays lit until something else is picked.
  const sentTo = selectedNode && built ? blockForNode(built, selectedNode, page.file) : null
  const pinned = chosen ?? sentTo
  const active = stage === 'wired' ? (hovered ?? pinned) : null
  const touching = useMemoTouching(built, active)
  const focused = useMemoTouching(built, stage === 'wired' ? pinned : null)

  const clearChoice = () => {
    if (pinned === null) return
    setChosen(null)
    selectNode(null)
    if (built) moveTo(built.bounds, FOCUS_SECONDS)
  }
  // Picking a block brings it and everything it touches close enough to read.
  const choose = (id: string) => {
    if (dragged() || !built) return
    if (pinned === id) {
      clearChoice()
      return
    }
    setChosen(id)
    const ids = new Set([id, ...built.arrows.flatMap((arrow) => (arrow.from === id ? arrow.to : arrow.to === id ? arrow.from : []))])
    moveTo(boundsOf([...built.blocks, ...built.cards].filter((box) => ids.has(box.id))), FOCUS_SECONDS, FOCUS_PADDING)
  }

  if (failed) {
    return (
      <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
        Could not read {page.file} from the server.
      </p>
    )
  }

  const markedLines = new Set(
    built?.arrows.filter((arrow) => arrow.from === active && arrow.line !== null).map((arrow) => arrow.line!) ?? [],
  )

  return (
    <div
      ref={frame}
      data-testid="file-blocks"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onClick={() => {
        if (!dragged()) clearChoice()
      }}
      className="absolute inset-0 cursor-grab overflow-hidden bg-background select-none active:cursor-grabbing"
      style={{
        backgroundImage: 'radial-gradient(rgb(196 206 232 / 9%) 1px, transparent 1px)',
        backgroundSize: '26px 26px',
      }}
    >
      {!built && <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">Reading {page.file}…</p>}
      {built && (
        <motion.div className="absolute top-0 left-0" style={{ x: panX, y: panY, scale: zoom, transformOrigin: '0 0' }}>
          {built.frames.map((box) => (
            <motion.div
              key={box.id}
              initial={false}
              animate={{ opacity: stage === 'wired' ? 1 : 0 }}
              className="absolute rounded-xl border border-dashed"
              style={{ left: box.x, top: box.y, width: box.width, height: box.height, borderColor: 'rgb(241 223 174 / 28%)' }}
            />
          ))}
          {built.cards.map((card) => (
            <CallersCard
              key={card.id}
              card={card}
              shown={stage === 'wired'}
              dimmed={focused.size > 0 && !focused.has(card.id)}
              chosen={pinned === card.id}
              onChoose={() => choose(card.id)}
              onOpen={(nodeId) => onOpenFile(card.file, nodeId)}
            />
          ))}
          {built.blocks.map((block, order) => {
            const node = block.nodeId ? nodes.get(block.nodeId) : undefined
            return (
              <BlockCard
                key={block.id}
                block={block}
                order={order}
                stage={stage}
                colour={node ? colourOf(node) : colourOf(page.module)}
                tokens={loaded.tokens.get(block.file)}
                glyph={node && node.type !== 'module' ? node.type : null}
                dimmed={focused.size > 0 && !focused.has(block.id)}
                chosen={pinned === block.id}
                lit={active !== null && touching.has(block.id)}
                markedLines={block.id === active ? markedLines : NO_LINES}
                onChoose={() => choose(block.id)}
                onHover={(on) => setHovered(on ? block.id : null)}
                onOpenFile={() => onOpenFile(block.file, block.id)}
              />
            )
          })}
          <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--foreground)" />
              </marker>
              <marker id="arrow-broken" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--status-gap)" />
              </marker>
            </defs>
            {built.arrows.map((arrow, order) => (
              <ArrowLine
                key={arrow.id}
                arrow={arrow}
                stage={stage}
                order={order}
                lit={active !== null && (arrow.from === active || arrow.to === active)}
                dimmed={active !== null && arrow.from !== active && arrow.to !== active}
                stroke={stroke}
              />
            ))}
          </svg>
        </motion.div>
      )}
    </div>
  )
}

const NO_LINES = new Set<number>()

function useMemoTouching(built: BlockPage | undefined, active: string | null) {
  return useMemo(() => {
    const ids = new Set<string>()
    if (!built || !active) return ids
    ids.add(active)
    for (const arrow of built.arrows) {
      if (arrow.from === active) ids.add(arrow.to)
      if (arrow.to === active) ids.add(arrow.from)
    }
    return ids
  }, [built, active])
}
