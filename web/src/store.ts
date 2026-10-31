import { create } from 'zustand'

import type { AgentEvent } from '@/types/contracts/events.schema'

export type NodeState = 'unexplored' | 'visited' | 'understood'

export interface AgentRun {
  status: 'idle' | 'running' | 'done' | 'error'
  events: AgentEvent[]
}

interface TraceStore {
  selectedNode: string | null
  agentRun: AgentRun
  learningMode: boolean
  nodeStates: Record<string, NodeState>
  selectNode: (id: string | null) => void
  startRun: () => void
  addEvent: (event: AgentEvent) => void
  finishRun: (status: 'done' | 'error') => void
  setLearningMode: (on: boolean) => void
  setNodeState: (id: string, state: NodeState) => void
}

export const useTraceStore = create<TraceStore>((set) => ({
  selectedNode: null,
  agentRun: { status: 'idle', events: [] },
  learningMode: false,
  nodeStates: {},
  selectNode: (id) => set({ selectedNode: id }),
  startRun: () => set({ agentRun: { status: 'running', events: [] } }),
  addEvent: (event) =>
    set((state) => ({ agentRun: { ...state.agentRun, events: [...state.agentRun.events, event] } })),
  finishRun: (status) => set((state) => ({ agentRun: { ...state.agentRun, status } })),
  setLearningMode: (on) => set({ learningMode: on }),
  setNodeState: (id, nodeState) =>
    set((state) => ({ nodeStates: { ...state.nodeStates, [id]: nodeState } })),
}))
