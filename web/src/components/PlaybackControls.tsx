import { ChevronRight, ChevronsRight } from 'lucide-react'
import { useEffect } from 'react'

import type { RunView } from '@/lib/run'
import { useWaitingForStep } from '@/lib/useWaitingForStep'
import { cn } from '@/lib/utils'
import { useTraceStore, type StepMode } from '@/store'

const MODES: { mode: StepMode; label: string; hint: string }[] = [
  { mode: 'auto', label: 'Auto', hint: 'The answer plays by itself' },
  { mode: 'manual', label: 'Manual', hint: 'Press Next step to move through the answer' },
]

export function StepModeSwitch({ className }: { className?: string }) {
  const stepMode = useTraceStore((state) => state.stepMode)
  const setStepMode = useTraceStore((state) => state.setStepMode)
  return (
    <div role="radiogroup" aria-label="Playback" className={cn('flex rounded border border-border p-0.5 text-[11px]', className)}>
      {MODES.map(({ mode, label, hint }) => (
        <button
          key={mode}
          role="radio"
          aria-checked={stepMode === mode}
          title={hint}
          onClick={() => setStepMode(mode)}
          className={cn(
            'flex-1 rounded-[3px] px-2.5 py-0.5 transition-colors',
            stepMode === mode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))
}

// The bar at the top of the answer: the mode, where the reader is, and in manual mode the button that moves them on.
export function PlaybackBar({ run }: { run: RunView }) {
  const stepMode = useTraceStore((state) => state.stepMode)
  const advancePlayback = useTraceStore((state) => state.advancePlayback)
  const skipPlayback = useTraceStore((state) => state.skipPlayback)
  const waiting = useWaitingForStep()
  const drawing = run.totalSteps > 0
  const repairing = run.repair?.stage === 'repairing'

  useEffect(() => {
    if (!waiting) return
    function onKeyDown(event: KeyboardEvent) {
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 'ArrowRight' && event.key !== 'n') return
      event.preventDefault()
      advancePlayback()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [waiting, advancePlayback])

  let position = 'Investigating'
  if (repairing) position = 'Repair sent back'
  else if (drawing) position = `Step ${Math.max(1, run.revealed)} of ${run.totalSteps}`
  if (run.phase === 'settled') position = `${run.totalSteps} steps`

  return (
    <div className="flex items-center gap-2">
      <StepModeSwitch />
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{position}</span>
      {stepMode === 'manual' && run.phase !== 'settled' && (
        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={skipPlayback}
            disabled={!waiting}
            title="Show the rest of the answer"
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <ChevronsRight aria-hidden className="size-3.5" />
            Show all
          </button>
          <button
            onClick={advancePlayback}
            disabled={!waiting}
            className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity disabled:opacity-40"
          >
            Next step
            <ChevronRight aria-hidden className="size-3.5" />
            <kbd className="ml-0.5 rounded-sm bg-black/20 px-1 font-mono text-[10px]">→</kbd>
          </button>
        </span>
      )}
    </div>
  )
}
