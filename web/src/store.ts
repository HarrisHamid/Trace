import { create } from 'zustand'

import { isRevealing, nextDelay } from '@/lib/run'
import type { AgentEvent } from '@/types/contracts/events.schema'

export type NodeState = 'unexplored' | 'visited' | 'understood'

export interface AgentRun {
  status: 'idle' | 'running' | 'done' | 'error'
  question: string
  events: AgentEvent[]
}

// Animation lags behind the stream: cursor counts events already shown, pathStep counts revealed path steps.
export interface Playback {
  cursor: number
  pathStep: number
}

// Auto plays the answer by itself. Manual waits for the reader to press Next step.
export type StepMode = 'auto' | 'manual'

const STEP_MODE_KEY = 'trace.stepMode'

// A remembered preference only. Private windows and blocked storage fall back to auto.
function savedStepMode(): StepMode {
  try {
    return window.localStorage.getItem(STEP_MODE_KEY) === 'manual' ? 'manual' : 'auto'
  } catch {
    return 'auto'
  }
}

function saveStepMode(mode: StepMode) {
  try {
    window.localStorage.setItem(STEP_MODE_KEY, mode)
  } catch {
    // Nothing to do: the mode still applies for this visit.
  }
}

function advanced(events: AgentEvent[], playback: Playback): Playback {
  return isRevealing(events, playback)
    ? { ...playback, pathStep: playback.pathStep + 1 }
    : { ...playback, cursor: playback.cursor + 1 }
}

export interface View {
  level: 'codebase' | 'file'
  module: string | null
  // Set when something else has already placed the camera, so the view change must not fly it.
  still?: boolean
}

export interface CodePanel {
  nodeId: string
  quote: string | null
}

// One call line or one hop of the answer, picked out on the map.
export interface PinnedLine {
  from: string
  to: string
}

export interface FocusRequest {
  nodeId: string
  nonce: number
}

interface TraceStore {
  selectedNode: string | null
  agentRun: AgentRun
  playback: Playback
  stepMode: StepMode
  view: View
  paletteOpen: boolean
  codePanel: CodePanel | null
  focusRequest: FocusRequest | null
  showWiring: boolean
  showCallLines: boolean
  pinnedLine: PinnedLine | null
  learningMode: boolean
  nodeStates: Record<string, NodeState>
  openNode: (id: string, quote?: string | null) => void
  clearSelection: () => void
  closeCode: () => void
  selectNode: (id: string | null) => void
  focusNode: (id: string) => void
  enterModule: (module: string, still?: boolean) => void
  exitModule: () => void
  setPaletteOpen: (open: boolean) => void
  setShowWiring: (on: boolean) => void
  setShowCallLines: (on: boolean) => void
  pinLine: (line: PinnedLine | null) => void
  togglePinnedLine: (line: PinnedLine) => void
  startRun: (question: string) => void
  clearRun: () => void
  addEvent: (event: AgentEvent) => void
  finishRun: (status: 'done' | 'error') => void
  advancePlayback: () => void
  // Shows everything that has arrived so far, for a reader in manual mode who wants the rest at once.
  skipPlayback: () => void
  setStepMode: (mode: StepMode) => void
  setLearningMode: (on: boolean) => void
  setNodeState: (id: string, state: NodeState) => void
}

const CODEBASE: View = { level: 'codebase', module: null }
const NO_RUN: AgentRun = { status: 'idle', question: '', events: [] }
const NO_PLAYBACK: Playback = { cursor: 0, pathStep: 0 }

export const useTraceStore = create<TraceStore>((set) => ({
  selectedNode: null,
  agentRun: NO_RUN,
  playback: NO_PLAYBACK,
  stepMode: savedStepMode(),
  view: CODEBASE,
  paletteOpen: false,
  codePanel: null,
  focusRequest: null,
  showWiring: false,
  showCallLines: false,
  pinnedLine: null,
  learningMode: false,
  nodeStates: {},
  openNode: (id, quote = null) => set({ selectedNode: id, codePanel: { nodeId: id, quote } }),
  clearSelection: () => set({ selectedNode: null, codePanel: null }),
  closeCode: () => set({ codePanel: null }),
  selectNode: (id) => set({ selectedNode: id }),
  focusNode: (id) =>
    set((state) => ({ focusRequest: { nodeId: id, nonce: (state.focusRequest?.nonce ?? 0) + 1 } })),
  enterModule: (module, still = false) => set({ view: { level: 'file', module, still }, codePanel: null }),
  exitModule: () => set({ view: CODEBASE }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setShowWiring: (on) => set({ showWiring: on }),
  setShowCallLines: (on) => set({ showCallLines: on }),
  pinLine: (line) => set({ pinnedLine: line }),
  togglePinnedLine: (line) =>
    set(({ pinnedLine }) => ({
      pinnedLine: pinnedLine?.from === line.from && pinnedLine.to === line.to ? null : line,
    })),
  startRun: (question) =>
    set({
      agentRun: { status: 'running', question, events: [] },
      playback: NO_PLAYBACK,
      view: CODEBASE,
      codePanel: null,
      pinnedLine: null,
    }),
  clearRun: () =>
    set({ agentRun: NO_RUN, playback: NO_PLAYBACK, selectedNode: null, codePanel: null, pinnedLine: null }),
  addEvent: (event) =>
    set((state) => ({ agentRun: { ...state.agentRun, events: [...state.agentRun.events, event] } })),
  finishRun: (status) => set((state) => ({ agentRun: { ...state.agentRun, status } })),
  advancePlayback: () => set(({ agentRun, playback }) => ({ playback: advanced(agentRun.events, playback) })),
  skipPlayback: () =>
    set(({ agentRun, playback }) => {
      let next = playback
      for (let guard = 0; guard < 5000 && nextDelay(agentRun.events, next) !== null; guard += 1) {
        next = advanced(agentRun.events, next)
      }
      return { playback: next }
    }),
  setStepMode: (mode) => {
    saveStepMode(mode)
    set({ stepMode: mode })
  },
  setLearningMode: (on) => set({ learningMode: on }),
  setNodeState: (id, nodeState) =>
    set((state) => ({ nodeStates: { ...state.nodeStates, [id]: nodeState } })),
}))
