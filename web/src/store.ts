import { create } from 'zustand'

import { isRevealing } from '@/lib/run'
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

export interface View {
  level: 'codebase' | 'file'
  module: string | null
}

export interface CodePanel {
  nodeId: string
  quote: string | null
}

export interface FocusRequest {
  nodeId: string
  nonce: number
}

interface TraceStore {
  selectedNode: string | null
  agentRun: AgentRun
  playback: Playback
  view: View
  paletteOpen: boolean
  codePanel: CodePanel | null
  focusRequest: FocusRequest | null
  showWiring: boolean
  learningMode: boolean
  nodeStates: Record<string, NodeState>
  openNode: (id: string, quote?: string | null) => void
  clearSelection: () => void
  closeCode: () => void
  focusNode: (id: string) => void
  enterModule: (module: string) => void
  exitModule: () => void
  setPaletteOpen: (open: boolean) => void
  setShowWiring: (on: boolean) => void
  startRun: (question: string) => void
  addEvent: (event: AgentEvent) => void
  finishRun: (status: 'done' | 'error') => void
  advancePlayback: () => void
  setLearningMode: (on: boolean) => void
  setNodeState: (id: string, state: NodeState) => void
}

const CODEBASE: View = { level: 'codebase', module: null }

export const useTraceStore = create<TraceStore>((set) => ({
  selectedNode: null,
  agentRun: { status: 'idle', question: '', events: [] },
  playback: { cursor: 0, pathStep: 0 },
  view: CODEBASE,
  paletteOpen: false,
  codePanel: null,
  focusRequest: null,
  showWiring: false,
  learningMode: false,
  nodeStates: {},
  openNode: (id, quote = null) => set({ selectedNode: id, codePanel: { nodeId: id, quote } }),
  clearSelection: () => set({ selectedNode: null, codePanel: null }),
  closeCode: () => set({ codePanel: null }),
  focusNode: (id) =>
    set((state) => ({ focusRequest: { nodeId: id, nonce: (state.focusRequest?.nonce ?? 0) + 1 } })),
  enterModule: (module) => set({ view: { level: 'file', module }, codePanel: null }),
  exitModule: () => set({ view: CODEBASE }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setShowWiring: (on) => set({ showWiring: on }),
  startRun: (question) =>
    set({
      agentRun: { status: 'running', question, events: [] },
      playback: { cursor: 0, pathStep: 0 },
      view: CODEBASE,
      codePanel: null,
    }),
  addEvent: (event) =>
    set((state) => ({ agentRun: { ...state.agentRun, events: [...state.agentRun.events, event] } })),
  finishRun: (status) => set((state) => ({ agentRun: { ...state.agentRun, status } })),
  advancePlayback: () =>
    set(({ agentRun, playback }) => ({
      playback: isRevealing(agentRun.events, playback)
        ? { ...playback, pathStep: playback.pathStep + 1 }
        : { ...playback, cursor: playback.cursor + 1 },
    })),
  setLearningMode: (on) => set({ learningMode: on }),
  setNodeState: (id, nodeState) =>
    set((state) => ({ nodeStates: { ...state.nodeStates, [id]: nodeState } })),
}))
