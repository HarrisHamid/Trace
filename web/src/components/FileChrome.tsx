import { RotateCcw } from 'lucide-react'

import { footerLine, summaryLine, type FileGraph } from '@/lib/filegraph'
import { MAP_HASH } from '@/lib/route'

// What sits around a file's page: the summary along the bottom, and the message for a file with nothing to draw.

export function FileBar({ page, onReplay }: { page: FileGraph; onReplay: () => void }) {
  return (
    <footer className="absolute right-7 bottom-5 left-7 flex items-center gap-3 text-[11px] whitespace-nowrap text-muted-foreground">
      <button
        onClick={onReplay}
        className="glass flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors hover:text-foreground"
      >
        <RotateCcw className="size-3.5" />
        Replay
      </button>
      <p className="glass min-w-0 truncate px-3 py-1.5 text-foreground">{summaryLine(page.summary)}</p>
      <span className="ml-auto shrink-0">{footerLine(page.summary)}</span>
    </footer>
  )
}

export function FileMessage({ file, page }: { file: string; page: FileGraph | null }) {
  return (
    <section className="absolute inset-0 grid place-items-center">
      <div className="glass max-w-md px-6 py-5">
        <p className="kicker">Nothing to graph</p>
        <h2 className="mt-2 font-serif text-2xl leading-tight break-words">{file}</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          {page ? 'This file is empty.' : 'This path is not a file in the graph.'}
        </p>
        <a href={MAP_HASH} className="mt-4 inline-block text-xs text-primary transition-colors hover:text-foreground">
          Back to the map
        </a>
      </div>
    </section>
  )
}
