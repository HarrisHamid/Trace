import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, ChevronUp } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'

import { askNote, EXAMPLES, EXAMPLES_REPO, STRIP_COUNT, type AskNote } from '@/lib/examples'
import { cn } from '@/lib/utils'
import { useTraceStore } from '@/store'

const LIST_ID = 'ask-examples'
const FOCUS_RING = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'
const CELL = cn(
  'flex flex-1 items-center justify-center gap-1 border-l border-border px-2 whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground motion-reduce:transition-none',
  FOCUS_RING,
)

interface ExampleStripProps {
  note: AskNote | null
  listOpen: boolean
  toggleRef: RefObject<HTMLButtonElement | null>
  onAsk: (question: string) => void
  onToggle: () => void
}

function ExampleStrip({ note, listOpen, toggleRef, onAsk, onToggle }: ExampleStripProps) {
  return (
    <div className="flex h-7 items-stretch border-b border-border text-[11px]">
      <span className="kicker flex shrink-0 items-center px-3">{note?.kicker ?? 'Recorded'}</span>
      {/* Stays mounted when empty, because a screen reader only announces a live region that was already there. */}
      <p role="status" className={note ? 'flex flex-1 items-center border-l border-border px-3 text-muted-foreground' : 'sr-only'}>
        {note?.text}
      </p>
      {!note && (
        <>
          {EXAMPLES.slice(0, STRIP_COUNT).map((example) => (
            <button key={example.label} type="button" title={example.question} onClick={() => onAsk(example.question)} className={CELL}>
              {example.label}
            </button>
          ))}
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={listOpen}
            aria-controls={LIST_ID}
            onClick={onToggle}
            className={cn(CELL, 'flex-none')}
          >
            All {EXAMPLES.length}
            <ChevronUp aria-hidden className={cn('size-3 transition-transform motion-reduce:transition-none', listOpen && 'rotate-180')} />
          </button>
        </>
      )}
    </div>
  )
}

function ExampleList({ onAsk }: { onAsk: (question: string) => void }) {
  return (
    <motion.div
      id={LIST_ID}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="glass absolute inset-x-0 bottom-full mb-1.5 bg-[rgb(12_14_21/97%)]"
    >
      <p className="border-b border-border px-4 py-2 text-[11px] text-muted-foreground">
        Saved runs replay in about 10 seconds. Typed questions run live, about a minute.
      </p>
      <ul className="py-1">
        {EXAMPLES.map((example, index) => (
          <li key={example.label}>
            <button
              type="button"
              // The list sits before the strip so its glass can blur the map, so focus has to be moved into it.
              autoFocus={index === 0}
              onClick={() => onAsk(example.question)}
              className={cn(
                'block w-full px-4 py-0.5 text-left font-serif text-base text-foreground/90 transition-colors hover:bg-accent hover:text-foreground motion-reduce:transition-none',
                FOCUS_RING,
              )}
            >
              {example.question}
            </button>
          </li>
        ))}
      </ul>
    </motion.div>
  )
}

interface AskBarProps {
  busy: boolean
  repo: string
  rightInset: number
  onAsk: (question: string) => void
}

export function AskBar({ busy, repo, rightInset, onAsk }: AskBarProps) {
  const [question, setQuestion] = useState('')
  const [listOpen, setListOpen] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const asked = useTraceStore((state) => state.agentRun.question)

  // The saved answers are for one repo. Mock data replays one run whatever is asked, so it keeps its single chip.
  const hasExamples = repo === EXAMPLES_REPO
  const note = hasExamples ? askNote(busy, asked, question) : null

  useEffect(() => {
    if (!listOpen) return
    function onPointerDown(event: PointerEvent) {
      if (!bar.current?.contains(event.target as Node)) setListOpen(false)
    }
    // In the capture phase, so that Escape closes only the list and never reaches the chain in Workspace.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || useTraceStore.getState().paletteOpen) return
      event.stopPropagation()
      setListOpen(false)
      toggle.current?.focus()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [listOpen])

  function ask(text: string) {
    setListOpen(false)
    setQuestion('')
    onAsk(text)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (question.trim()) ask(question.trim())
  }

  return (
    <form
      onSubmit={submit}
      className="pointer-events-none absolute bottom-13 left-7 flex justify-center transition-[right] duration-300"
      style={{ right: rightInset }}
    >
      <div ref={bar} className="pointer-events-auto relative w-full max-w-2xl">
        <AnimatePresence>{listOpen && <ExampleList key="examples" onAsk={ask} />}</AnimatePresence>
        <div className="glass focus-within:border-primary/60">
          {hasExamples && (
            <ExampleStrip
              note={note}
              listOpen={listOpen}
              toggleRef={toggle}
              onAsk={ask}
              onToggle={() => setListOpen(!listOpen)}
            />
          )}
          <div className="flex items-center gap-3 py-1.5 pr-1.5 pl-4">
            <input
              aria-label="Ask the codebase"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onFocus={() => setListOpen(false)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || !question) return
                event.stopPropagation()
                setQuestion('')
              }}
              disabled={busy}
              placeholder="Ask the codebase…"
              className="min-w-0 flex-1 bg-transparent font-serif text-xl text-foreground italic outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />
            {!hasExamples && !question && (
              <button
                type="button"
                disabled={busy}
                onClick={() => ask(EXAMPLES[0].question)}
                className="shrink-0 border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:opacity-40"
              >
                {EXAMPLES[0].question}
              </button>
            )}
            <button
              type="submit"
              disabled={busy || !question.trim()}
              className="flex shrink-0 items-center gap-2 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
            >
              {busy ? 'Tracing' : 'Trace'}
              <ArrowRight className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </form>
  )
}
