import { ArrowRight, Boxes, ListVideo, LoaderCircle, MessageSquareText, Network, PanelLeftOpen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'

import { StepModeSwitch } from '@/components/PlaybackControls'
import { askNote, EXAMPLES, EXAMPLES_REPO, answerSlug } from '@/lib/examples'
import { fileHash } from '@/lib/route'
import type { GraphNode } from '@/lib/run'
import type { Scene } from '@/lib/scene'
import { cn } from '@/lib/utils'
import { useTraceStore } from '@/store'

export const SIDEBAR_WIDTH = 288
export const RAIL_WIDTH = 44

const ASK_INPUT_ID = 'sidebar-ask'
const QUESTIONS_ID = 'sidebar-questions'
const MODULES_ID = 'sidebar-modules'

function Section({
  id,
  title,
  aside,
  children,
  className,
}: {
  id?: string
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} className={cn('border-b border-border', className)}>
      <header className="flex h-8 items-center justify-between px-3">
        <h2 className="kicker">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

interface AskBoxProps {
  busy: boolean
  hasExamples: boolean
  // The file whose page is open. A question typed there is about that file.
  scope: string | null
  onAsk: (question: string, file: string | null) => void
}

function AskBox({ busy, hasExamples, scope, onAsk }: AskBoxProps) {
  const [question, setQuestion] = useState('')
  const asked = useTraceStore((state) => state.agentRun.question)
  const askedFile = useTraceStore((state) => state.agentRun.file)
  const note = hasExamples || scope ? askNote(busy, asked, question, askedFile, scope) : null
  const name = scope?.slice(scope.lastIndexOf('/') + 1)

  function ask() {
    const text = question.trim()
    if (!text || busy) return
    setQuestion('')
    onAsk(text, scope)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    ask()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      ask()
    } else if (event.key === 'Escape' && question) {
      event.stopPropagation()
      setQuestion('')
    }
  }

  return (
    <form onSubmit={submit} className="px-3 pb-3">
      <div className="rounded border border-input bg-background focus-within:border-primary/70">
        <textarea
          id={ASK_INPUT_ID}
          aria-label={name ? `Ask about ${name}` : 'Ask about this codebase'}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          rows={3}
          placeholder={name ? `Ask about ${name}…` : 'How does a user log in?'}
          className="block w-full resize-none bg-transparent px-2.5 pt-2 text-[13px] leading-snug outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <span className="text-[10px] text-muted-foreground">Enter to ask · Shift+Enter for a new line</span>
          <button
            type="submit"
            disabled={busy || !question.trim()}
            className="flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
          >
            {busy ? 'Running' : 'Ask'}
            <ArrowRight aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>
      {/* Stays mounted when empty, because a screen reader only announces a live region that was already there. */}
      <p role="status" className={note ? 'mt-2 text-[11px] leading-snug text-muted-foreground' : 'sr-only'}>
        {note && <span className="mr-1.5 font-semibold text-foreground/80">{note.kicker}</span>}
        {note?.text}
      </p>
    </form>
  )
}

function Questions({ busy, onAsk }: { busy: boolean; onAsk: (question: string) => void }) {
  const asked = useTraceStore((state) => state.agentRun.question)
  const askedFile = useTraceStore((state) => state.agentRun.file)
  // A recorded question asked about one file ran live, so it is not this replay.
  const active = askedFile === null ? answerSlug(asked) : ''
  return (
    <ul className="pb-2">
      {EXAMPLES.map((example) => {
        const current = active !== '' && answerSlug(example.question) === active
        return (
          <li key={example.label}>
            <button
              disabled={busy}
              onClick={() => onAsk(example.question)}
              aria-current={current || undefined}
              title={example.question}
              className={cn(
                'block w-full border-l-2 px-3 py-1.5 text-left transition-colors disabled:cursor-not-allowed',
                current ? 'border-primary bg-accent' : 'border-transparent enabled:hover:bg-accent/60',
              )}
            >
              <span className="block text-[13px] text-foreground">{example.label}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{example.question}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function Modules({ scene, nodes, onFocusModule }: { scene: Scene; nodes: GraphNode[]; onFocusModule: (module: string | null) => void }) {
  const view = useTraceStore((state) => state.view)

  const rows = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    return scene.plates
      .filter((plate) => !plate.external)
      .map((plate) => ({
        plate,
        file: byId.get(plate.id)?.file ?? null,
        count: plate.members.length,
      }))
      .sort((a, b) => a.plate.id.localeCompare(b.plate.id))
  }, [scene, nodes])

  return (
    <ul className="pb-2">
      {rows.map(({ plate, file, count }) => {
        const current = view.module === plate.id
        return (
          <li
            key={plate.id}
            className={cn(
              'group flex items-center border-l-2',
              current ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/60',
            )}
          >
            <button
              onClick={() => onFocusModule(current ? null : plate.id)}
              aria-pressed={current}
              title={file ?? plate.id}
              className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-3 text-left"
            >
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: plate.colour }} />
              <span className="truncate font-mono text-xs text-foreground/90">{plate.id}</span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground tabular-nums">{count}</span>
            </button>
            {file && (
              <a
                href={fileHash(file)}
                title={`Graphify ${file}`}
                aria-label={`Graphify ${file}`}
                className="px-2 py-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary focus-visible:opacity-100"
              >
                <Network className="size-3.5" />
              </a>
            )}
          </li>
        )
      })}
    </ul>
  )
}

interface SidebarProps {
  repo: string
  busy: boolean
  scene: Scene
  nodes: GraphNode[]
  // The file whose page is open, if any. Typed questions are about it; recorded ones are about the whole repo.
  scope: string | null
  onAsk: (question: string, file: string | null) => void
  onFocusModule: (module: string | null) => void
}

interface RailButtonProps {
  label: string
  shortcut?: string
  onClick: () => void
  children: ReactNode
}

function RailButton({ label, shortcut, onClick, children }: RailButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className="grid size-8 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}

// The collapsed sidebar: one icon per section, each of which opens the sidebar at that section.
function Rail({ busy, onOpen }: { busy: boolean; onOpen: (target: string | null) => void }) {
  return (
    <nav
      aria-label="Sidebar"
      className="flex shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2"
      style={{ width: RAIL_WIDTH }}
    >
      <RailButton label="Show sidebar" shortcut="⌘B" onClick={() => onOpen(null)}>
        <PanelLeftOpen className="size-4" />
      </RailButton>
      <span className="my-1 w-5 border-t border-border" />
      <RailButton label={busy ? 'Ask (a run is in progress)' : 'Ask'} onClick={() => onOpen(ASK_INPUT_ID)}>
        {busy ? (
          <LoaderCircle className="size-4 animate-spin text-primary motion-reduce:animate-none" />
        ) : (
          <MessageSquareText className="size-4" />
        )}
      </RailButton>
      <RailButton label="Recorded questions" onClick={() => onOpen(QUESTIONS_ID)}>
        <ListVideo className="size-4" />
      </RailButton>
      <RailButton label="Modules" onClick={() => onOpen(MODULES_ID)}>
        <Boxes className="size-4" />
      </RailButton>
    </nav>
  )
}

export function Sidebar({ repo, busy, scene, nodes, scope, onAsk, onFocusModule }: SidebarProps) {
  const open = useTraceStore((state) => state.sidebarOpen)
  const setOpen = useTraceStore((state) => state.setSidebarOpen)
  const target = useRef<string | null>(null)
  // The recorded answers are for one repo. Mock data replays one run whatever is asked, so it offers just that one.
  const hasExamples = repo === EXAMPLES_REPO

  // A rail icon opens the sidebar, then the section it named is brought into view once it exists.
  useEffect(() => {
    if (!open || !target.current) return
    const element = document.getElementById(target.current)
    if (target.current === ASK_INPUT_ID) element?.focus()
    else element?.scrollIntoView({ block: 'start' })
    target.current = null
  }, [open])

  if (!open) {
    return (
      <Rail
        busy={busy}
        onOpen={(section) => {
          target.current = section
          setOpen(true)
        }}
      />
    )
  }

  return (
    <aside aria-label="Sidebar" className="flex min-h-0 shrink-0 flex-col border-r border-border bg-card" style={{ width: SIDEBAR_WIDTH }}>
      <Section title="Ask" aside={<StepModeSwitch className="w-32" />}>
        <AskBox busy={busy} hasExamples={hasExamples} scope={scope} onAsk={onAsk} />
      </Section>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hasExamples ? (
          <Section id={QUESTIONS_ID} title="Recorded questions" aside={<span className="text-[10px] text-muted-foreground">replays</span>}>
            <Questions busy={busy} onAsk={(question) => onAsk(question, null)} />
          </Section>
        ) : (
          <Section title="Example">
            <button
              disabled={busy}
              onClick={() => onAsk(EXAMPLES[0].question, null)}
              className="mx-3 mb-3 rounded border border-border px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              {EXAMPLES[0].question}
            </button>
          </Section>
        )}
        <Section
          id={MODULES_ID}
          title="Modules"
          className="border-b-0"
          aside={<span className="text-[10px] text-muted-foreground">click to focus</span>}
        >
          <Modules scene={scene} nodes={nodes} onFocusModule={onFocusModule} />
        </Section>
      </div>
    </aside>
  )
}
