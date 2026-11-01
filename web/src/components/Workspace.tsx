import { AnimatePresence, MotionConfig } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { fetchGraph, streamAsk } from '@/api'
import { AskBar } from '@/components/AskBar'
import { CODE_WIDTH, CodePanel } from '@/components/CodePanel'
import { CommandPalette } from '@/components/CommandPalette'
import { FileBlocks, type FileCamera } from '@/components/FileBlocks'
import { FileBar, FileMessage } from '@/components/FileChrome'
import { GraphView, type MapCamera } from '@/components/GraphView'
import { Legend, TopBar } from '@/components/MapChrome'
import { LOG_WIDTH, ObservationLog } from '@/components/ObservationLog'
import { buildFileGraph, EXTERNAL_FILE } from '@/lib/filegraph'
import { fileHash, fileRoute, MAP_HASH, readHash, subscribeToHash } from '@/lib/route'
import { deriveRun, nextDelay, type GraphNode } from '@/lib/run'
import { buildScene } from '@/lib/scene'
import { useDive } from '@/lib/useDive'
import { cn } from '@/lib/utils'
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

function goToFile(file: string) {
  window.location.hash = fileHash(file)
}

function fadeChrome(shown: boolean) {
  return cn('transition-opacity duration-200 motion-reduce:transition-none', shown ? 'opacity-100' : 'pointer-events-none opacity-0')
}

export function Workspace() {
  const [graph, setGraph] = useState<Graph | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const agentRun = useTraceStore((state) => state.agentRun)
  const playback = useTraceStore((state) => state.playback)
  const view = useTraceStore((state) => state.view)
  const codePanel = useTraceStore((state) => state.codePanel)
  const paletteOpen = useTraceStore((state) => state.paletteOpen)
  const { startRun, addEvent, finishRun, closeCode, exitModule, enterModule, openNode, focusNode, selectNode } =
    useTraceStore()

  const route = fileRoute(useSyncExternalStore(subscribeToHash, readHash))
  const mapCamera = useRef<MapCamera>(null)
  const fileCamera = useRef<FileCamera>(null)

  usePlayback()

  useEffect(() => {
    fetchGraph().then(setGraph, (error: Error) => setLoadError(error.message))
  }, [])

  const pageOf = useCallback((file: string) => (graph ? buildFileGraph(graph, file) : null), [graph])
  const dive = useDive({ route, ready: graph !== null, pageOf, map: mapCamera, file: fileCamera })
  const moving = dive.stage === 'dive' || dive.stage === 'back'

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || paletteOpen || moving) return
      if (codePanel) closeCode()
      else if (route) window.location.hash = MAP_HASH
      else if (view.level === 'file') exitModule()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [paletteOpen, moving, route, codePanel, view, closeCode, exitModule])

  const run = useMemo(() => (graph ? deriveRun(graph, agentRun, playback) : null), [graph, agentRun, playback])
  const scene = useMemo(() => (graph ? buildScene(graph) : null), [graph])
  const nodesById = useMemo(() => new Map<string, GraphNode>(graph?.nodes.map((node) => [node.id, node])), [graph])
  const page = useMemo(() => (dive.mounted ? pageOf(dive.mounted) : null), [dive.mounted, pageOf])

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
    if (route) {
      if (node.file === EXTERNAL_FILE) return
      selectNode(node.id)
      if (node.file !== route) goToFile(node.file)
      return
    }
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

  const onMap = dive.stage === 'map' || dive.stage === 'back'
  const logOpen = run !== null && run.phase !== 'idle' && onMap
  const codeNode = codePanel ? nodesById.get(codePanel.nodeId) : undefined
  let rightInset = EDGE_MARGIN
  if (logOpen) rightInset = LOG_WIDTH + PANEL_MARGIN
  if (codeNode) rightInset = CODE_WIDTH + PANEL_MARGIN

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative h-dvh min-w-[1280px] overflow-hidden bg-background text-foreground">
        {graph && scene && run && (
          <div
            className="absolute inset-0"
            style={{ visibility: dive.mapShown ? 'visible' : 'hidden', pointerEvents: dive.stage === 'map' ? undefined : 'none' }}
          >
            <GraphView
              graph={graph}
              scene={scene}
              run={run}
              rightInset={rightInset}
              paused={!dive.mapShown}
              camera={mapCamera}
            />
          </div>
        )}
        {page?.hasCanvas && scene && (
          <div
            key={page.file}
            className="absolute inset-0 transition-opacity duration-200 motion-reduce:transition-none"
            style={{ opacity: dive.fileShown ? 1 : 0, pointerEvents: dive.mapShown ? 'none' : undefined }}
          >
            <FileBlocks
              page={page}
              colourOf={scene.colourOf}
              animated={dive.animated}
              camera={fileCamera}
              onOpenFile={(file, nodeId) => {
                selectNode(nodeId)
                if (file !== route) goToFile(file)
              }}
            />
          </div>
        )}
        <div className="plate-vignette" />
        <div className="plate-frame" />
        {!graph && (
          <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            {loadError ?? 'Plotting the chart…'}
          </p>
        )}
        {graph && scene && run && (
          <>
            <TopBar
              graph={graph}
              moduleName={view.module ? (nodesById.get(view.module)?.name ?? view.module) : null}
              file={route}
            />
            <div className={fadeChrome(dive.stage === 'map')} inert={dive.stage !== 'map'}>
              <Legend graph={graph} rightInset={rightInset} />
              <AskBar
                busy={run.phase === 'walking' || run.phase === 'revealing'}
                rightInset={rightInset}
                onAsk={ask}
              />
            </div>
            {page?.hasCanvas && (
              <div className={fadeChrome(dive.stage === 'file')}>
                <FileBar page={page} onReplay={() => fileCamera.current?.replay()} />
              </div>
            )}
            {route && dive.stage === 'file' && !page?.hasCanvas && <FileMessage file={route} page={page} />}
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
                  graphifyBusy={run.phase === 'walking' || run.phase === 'revealing'}
                  onGraphify={
                    codeNode.type === 'external' || codeNode.file === dive.mounted
                      ? undefined
                      : () => goToFile(codeNode.file)
                  }
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
