import { ArrowRight, Network } from 'lucide-react'
import { useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'

import { StepModeSwitch } from '@/components/PlaybackControls'
import { askNote, EXAMPLES, EXAMPLES_REPO, answerSlug } from '@/lib/examples'
import { fileHash } from '@/lib/route'
import type { GraphNode } from '@/lib/run'
import type { Scene } from '@/lib/scene'
import { cn } from '@/lib/utils'
import { useTraceStore } from '@/store'

export const SIDEBAR_WIDTH = 288

function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('border-b border-border', className)}>
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
  onAsk: (question: string) => void
}

function AskBox({ busy, hasExamples, onAsk }: AskBoxProps) {
  const [question, setQuestion] = useState('')
  const asked = useTraceStore((state) => state.agentRun.question)
  const note = hasExamples ? askNote(busy, asked, question) : null

  function ask() {
    const text = question.trim()
    if (!text || busy) return
    setQuestion('')
    onAsk(text)
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
          aria-label="Ask about this codebase"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          rows={3}
          placeholder="How does a user log in?"
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
  const active = answerSlug(asked)
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
          <li key={plate.id} className={cn('group flex items-center border-l-2', current ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/60')}>
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
  onAsk: (question: string) => void
  onFocusModule: (module: string | null) => void
}

export function Sidebar({ repo, busy, scene, nodes, onAsk, onFocusModule }: SidebarProps) {
  // The recorded answers are for one repo. Mock data replays one run whatever is asked, so it offers just that one.
  const hasExamples = repo === EXAMPLES_REPO

  return (
    <aside aria-label="Sidebar" className="flex min-h-0 shrink-0 flex-col border-r border-border bg-card" style={{ width: SIDEBAR_WIDTH }}>
      <Section title="Ask" aside={<StepModeSwitch className="w-32" />}>
        <AskBox busy={busy} hasExamples={hasExamples} onAsk={onAsk} />
      </Section>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hasExamples ? (
          <Section title="Recorded questions" aside={<span className="text-[10px] text-muted-foreground">replays</span>}>
            <Questions busy={busy} onAsk={onAsk} />
          </Section>
        ) : (
          <Section title="Example">
            <button
              disabled={busy}
              onClick={() => onAsk(EXAMPLES[0].question)}
              className="mx-3 mb-3 rounded border border-border px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              {EXAMPLES[0].question}
            </button>
          </Section>
        )}
        <Section title="Modules" className="border-b-0" aside={<span className="text-[10px] text-muted-foreground">click to focus</span>}>
          <Modules scene={scene} nodes={nodes} onFocusModule={onFocusModule} />
        </Section>
      </div>
    </aside>
  )
}
