import { ArrowRight } from 'lucide-react'
import { useState, type FormEvent } from 'react'

const DEMO_QUESTION = 'How does login work?'

interface AskBarProps {
  busy: boolean
  rightInset: number
  onAsk: (question: string) => void
}

export function AskBar({ busy, rightInset, onAsk }: AskBarProps) {
  const [question, setQuestion] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (question.trim()) onAsk(question.trim())
  }

  return (
    <form
      onSubmit={submit}
      className="absolute bottom-12 left-7 flex justify-center transition-[right] duration-300"
      style={{ right: rightInset }}
    >
      <div className="glass flex w-full max-w-2xl items-center gap-3 py-1.5 pr-1.5 pl-4 focus-within:border-primary/60">
        <input
          aria-label="Ask the codebase"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={busy}
          placeholder="Ask the codebase…"
          className="min-w-0 flex-1 bg-transparent font-serif text-xl text-foreground italic outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        {!question && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAsk(DEMO_QUESTION)}
            className="shrink-0 border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:opacity-40"
          >
            {DEMO_QUESTION}
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
    </form>
  )
}
