import { awaitsStep } from '@/lib/run'
import { useTraceStore } from '@/store'

// True when manual mode is holding the answer for the reader.
export function useWaitingForStep() {
  const stepMode = useTraceStore((state) => state.stepMode)
  const events = useTraceStore((state) => state.agentRun.events)
  const playback = useTraceStore((state) => state.playback)
  return stepMode === 'manual' && awaitsStep(events, playback)
}
