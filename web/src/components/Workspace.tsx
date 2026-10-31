import { AnimatePresence, MotionConfig } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'

import { fetchGraph, streamAsk } from '@/api'
import { AskBar } from '@/components/AskBar'
import { CODE_WIDTH, CodePanel } from '@/components/CodePanel'
import { CommandPalette } from '@/components/CommandPalette'
import { GraphView } from '@/components/GraphView'
import { Legend, TopBar } from '@/components/MapChrome'
import { LOG_WIDTH, ObservationLog } from '@/components/ObservationLog'
import { deriveRun, nextDelay, type GraphNode } from '@/lib/run'
import { buildScene } from '@/lib/scene'
import { useTraceStore } from '@/store'
import type { Graph } from '@/types/contracts/graph.schema'

const PANEL_MARGIN = 44
const EDGE_MARGIN = 28

function usePlayback() {
  const events = useTraceStore((state) => state.agentRun.events)
  const playback = useTraceStore((state) => state.playback)
  const advancePlayback = useTraceStore((state) => state.advancePlayback)

  // Keyed on the delay, not the events: a new event must not restart the hold that is already running.
  const delay = nextDelay(events, playback)

  useEffect(() => {
    if (delay === null) return
    const timer = window.setTimeout(advancePlayback, delay)
    return () => window.clearTimeout(timer)
  }, [delay, playback, advancePlayback])
}

export function Workspace() {
  const [graph, setGraph] = useState<Graph | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const agentRun = useTraceStore((state) => state.agentRun)
  const playback = useTraceStore((state) => state.playback)
  const view = useTraceStore((state) => state.view)
  const codePanel = useTraceStore((state) => state.codePanel)
  const paletteOpen = useTraceStore((state) => state.paletteOpen)
  const { startRun, addEvent, finishRun, closeCode, exitModule, enterModule, openNode, focusNode } = useTraceStore()

  usePlayback()

  useEffect(() => {
    fetchGraph().then(setGraph, (error: Error) => setLoadError(error.message))
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || paletteOpen) return
      if (codePanel) closeCode()
      else if (view.level === 'file') exitModule()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [paletteOpen, codePanel, view, closeCode, exitModule])

  const run = useMemo(() => (graph ? deriveRun(graph, agentRun, playback) : null), [graph, agentRun, playback])
  const scene = useMemo(() => (graph ? buildScene(graph) : null), [graph])
  const nodesById = useMemo(() => new Map<string, GraphNode>(graph?.nodes.map((node) => [node.id, node])), [graph])

  async function ask(question: string) {
    startRun(question)
    try {
      await streamAsk(question, addEvent)
      finishRun('done')
    } catch (error) {
      addEvent({ type: 'error', message: (error as Error).message })
      finishRun('error')
    }
  }

  function pick(node: GraphNode) {
    if (node.type === 'module') {
      enterModule(node.id)
      return
    }
    const inModule = nodesById.has(node.module)
    if (view.level === 'file' && view.module !== node.module) {
      if (inModule) enterModule(node.module)
      else exitModule()
    }
    openNode(node.id)
    focusNode(node.id)
  }

  const logOpen = run !== null && run.phase !== 'idle'
  const codeNode = codePanel ? nodesById.get(codePanel.nodeId) : undefined
  let rightInset = EDGE_MARGIN
  if (logOpen) rightInset = LOG_WIDTH + PANEL_MARGIN
  if (codeNode) rightInset = CODE_WIDTH + PANEL_MARGIN

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative h-dvh min-w-[1280px] overflow-hidden bg-background text-foreground">
        {graph && scene && run && <GraphView graph={graph} scene={scene} run={run} rightInset={rightInset} />}
        <div className="plate-vignette" />
        <div className="plate-frame" />
        {!graph && (
          <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            {loadError ?? 'Plotting the chart…'}
          </p>
        )}
        {graph && scene && run && (
          <>
            <TopBar graph={graph} moduleName={view.module ? (nodesById.get(view.module)?.name ?? view.module) : null} />
            <Legend graph={graph} rightInset={rightInset} />
            <AskBar
              busy={run.phase === 'walking' || run.phase === 'revealing'}
              rightInset={rightInset}
              onAsk={ask}
            />
            <AnimatePresence>
              {logOpen && <ObservationLog key="log" run={run} scene={scene} nodesById={nodesById} />}
            </AnimatePresence>
            <AnimatePresence>
              {codeNode && (
                <CodePanel
                  key="code"
                  node={codeNode}
                  colour={scene.colourOf(codeNode)}
                  quote={codePanel?.quote ?? null}
                  onClose={closeCode}
                />
              )}
            </AnimatePresence>
            <CommandPalette nodes={graph.nodes} scene={scene} onPick={pick} />
          </>
        )}
      </div>
    </MotionConfig>
  )
}
