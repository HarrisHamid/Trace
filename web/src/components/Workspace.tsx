import { AnimatePresence, MotionConfig } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { fetchGraph, fetchRepos, streamAsk } from '@/api'
import { CODE_WIDTH, CodePanel } from '@/components/CodePanel'
import { CommandPalette } from '@/components/CommandPalette'
import { FileBlocks, type FileCamera } from '@/components/FileBlocks'
import { FileBar, FileMessage } from '@/components/FileChrome'
import { GraphView, type MapCamera } from '@/components/GraphView'
import { MapToolbar, PinnedLineChip, StatusBar, TitleBar } from '@/components/MapChrome'
import { LOG_WIDTH, ObservationLog } from '@/components/ObservationLog'

import { Sidebar } from '@/components/Sidebar'
import { EXAMPLES_REPO, replays } from '@/lib/examples'
import { buildFileGraph, EXTERNAL_FILE, isInside } from '@/lib/filegraph'
import { fileHash, fileRoute, MAP_HASH, readHash, REPOS_HASH, subscribeToHash } from '@/lib/route'
import { deriveRun, nextDelay, type GraphNode } from '@/lib/run'
import { buildScene } from '@/lib/scene'
import { useDive } from '@/lib/useDive'
import { cn } from '@/lib/utils'
import { useWaitingForStep } from '@/lib/useWaitingForStep'
import { useTraceStore } from '@/store'
import type { Graph } from '@/types/contracts/graph.schema'

const PANEL_MARGIN = 24
const EDGE_MARGIN = 16

function usePlayback() {
  const events = useTraceStore((state) => state.agentRun.events)
  const playback = useTraceStore((state) => state.playback)
  const advancePlayback = useTraceStore((state) => state.advancePlayback)
  const waiting = useWaitingForStep()

  // Keyed on the delay, not the events: a new event must not restart the hold that is already running.
  // In manual mode there is no timer at all while the answer waits for Next step.
  const delay = waiting ? null : nextDelay(events, playback)

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
  // Mock data replays one run for any question, so its sidebar offers that one question.
  const [replaysAny, setReplaysAny] = useState(false)
  const repoId = useTraceStore((state) => state.repo)
  const agentRun = useTraceStore((state) => state.agentRun)
  const playback = useTraceStore((state) => state.playback)
  const view = useTraceStore((state) => state.view)
  const codePanel = useTraceStore((state) => state.codePanel)
  const paletteOpen = useTraceStore((state) => state.paletteOpen)
  const pinnedLine = useTraceStore((state) => state.pinnedLine)
  const { pinLine, startRun, clearRun, addEvent, finishRun, clearSelection, exitModule, enterModule, openNode, focusNode, selectNode } =
    useTraceStore()

  const route = fileRoute(useSyncExternalStore(subscribeToHash, readHash))
  const mapCamera = useRef<MapCamera>(null)
  const fileCamera = useRef<FileCamera>(null)
  const asking = useRef<AbortController | null>(null)

  usePlayback()

  useEffect(() => {
    fetchGraph().then(setGraph, (error: Error) => setLoadError(error.message))
    fetchRepos().then(
      (repos) => setReplaysAny(repos.find((repo) => (repoId ? repo.id === repoId : repo.builtin))?.replays_any ?? false),
      () => setReplaysAny(false),
    )
  }, [repoId])

  const pageOf = useCallback((file: string) => (graph ? buildFileGraph(graph, file) : null), [graph])
  const dive = useDive({ route, ready: graph !== null, pageOf, map: mapCamera, file: fileCamera })
  const moving = dive.stage === 'dive' || dive.stage === 'back'

  const exitRun = useCallback(() => {
    asking.current?.abort()
    clearRun()
  }, [clearRun])

  const inRun = agentRun.status !== 'idle'
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || paletteOpen || moving) return
      if (codePanel) clearSelection()
      else if (route) window.location.hash = MAP_HASH
      else if (pinnedLine) pinLine(null)
      else if (view.level === 'file') exitModule()
      else if (inRun) exitRun()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [paletteOpen, moving, route, codePanel, view, inRun, pinnedLine, pinLine, clearSelection, exitModule, exitRun])

  // ⌘B or Ctrl+B shows and hides the sidebar, as in most editors.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      const { sidebarOpen, setSidebarOpen } = useTraceStore.getState()
      setSidebarOpen(!sidebarOpen)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const run = useMemo(() => (graph ? deriveRun(graph, agentRun, playback) : null), [graph, agentRun, playback])
  const scene = useMemo(() => (graph ? buildScene(graph) : null), [graph])
  const nodesById = useMemo(() => new Map<string, GraphNode>(graph?.nodes.map((node) => [node.id, node])), [graph])
  const page = useMemo(() => (dive.mounted ? pageOf(dive.mounted) : null), [dive.mounted, pageOf])

  // An action asked for on a file's page waits until the way back to the map has finished, because that return sets the
  // map's focus itself and would otherwise undo it.
  const afterMap = useRef<(() => void) | null>(null)
  function fromMap(action: () => void) {
    if (!route) {
      action()
      return
    }
    afterMap.current = action
    window.location.hash = MAP_HASH
  }
  useEffect(() => {
    if (route || dive.stage !== 'map' || !afterMap.current) return
    const action = afterMap.current
    afterMap.current = null
    action()
  }, [route, dive.stage])

  // A question typed on a file's page is about that file: the page stays open and the answer is followed there.
  // Anything else, recorded questions included, is about the whole repo and goes back to the map.
  function ask(question: string, file: string | null) {
    if (file !== null && file === route) void runQuestion(question, file)
    else fromMap(() => void runQuestion(question, null))
  }

  function focusModule(module: string | null) {
    fromMap(() => (module ? enterModule(module) : exitModule()))
  }

  async function runQuestion(question: string, file: string | null) {
    asking.current?.abort()
    const controller = new AbortController()
    asking.current = controller
    // Recorded answers, and the mock data that replays one run for any question, are not timed.
    startRun(question, graph?.repo === EXAMPLES_REPO && !replays(question, file), file)
    try {
      await streamAsk(question, file, addEvent, controller.signal)
      if (!controller.signal.aborted) finishRun('done')
    } catch (error) {
      if (controller.signal.aborted) return
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
    if (view.level === 'file' && view.module !== null && !isInside(node.module, view.module)) {
      if (inModule) enterModule(node.module)
      else exitModule()
    }
    openNode(node.id)
    focusNode(node.id)
  }

  const onMap = dive.stage === 'map' || dive.stage === 'back'
  // A run asked from a file's page is followed on that page: its answer panel shows there, and each step lights its block.
  const onAskedFile = route !== null && route === agentRun.file && dive.stage === 'file'
  const logOpen = run !== null && run.phase !== 'idle' && (onMap || onAskedFile)
  const current = onAskedFile ? (run?.current ?? null) : null
  useEffect(() => {
    if (current) selectNode(current)
  }, [current, selectNode])
  const codeNode = codePanel ? nodesById.get(codePanel.nodeId) : undefined
  let rightInset = EDGE_MARGIN
  if (logOpen) rightInset = LOG_WIDTH + PANEL_MARGIN
  if (codeNode) rightInset = CODE_WIDTH + PANEL_MARGIN

  const busy = run !== null && (run.phase === 'walking' || run.phase === 'revealing')

  return (
    <MotionConfig reducedMotion="user">
      {/* Clip, not hidden: a hidden overflow can still be scrolled by scrollIntoView, which slid the whole map sideways. */}
      <div className="flex h-dvh min-w-[1280px] flex-col overflow-clip bg-background text-foreground">
        {graph && run ? (
          <TitleBar
            graph={graph}
            moduleName={view.module ? (nodesById.get(view.module)?.name ?? view.module) : null}
            file={route}
            run={run}
            recorded={replays(run.question, agentRun.file)}
          />
        ) : (
          <div className="h-10 shrink-0 border-b border-border bg-card" />
        )}
        <div className="flex min-h-0 flex-1">
          {graph && scene && (
            <Sidebar
              repo={graph.repo}
              busy={busy}
              scene={scene}
              nodes={graph.nodes}
              replaysAny={replaysAny}
              scope={route && page?.hasCanvas ? route : null}
              onAsk={ask}
              onFocusModule={focusModule}
            />
          )}
          <main className="relative min-w-0 flex-1 overflow-clip">
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
                  follow={onAskedFile ? playback.cursor : null}
                  rightInset={rightInset}
                  onOpenFile={(file, nodeId) => {
                    selectNode(nodeId)
                    if (file !== route) goToFile(file)
                  }}
                />
              </div>
            )}
            {!graph && (
              <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
                <p className="text-center">
                  {loadError ?? 'Loading the code graph…'}
                  {loadError && (
                    <a href={REPOS_HASH} className="mt-2 block text-primary hover:underline">
                      Choose a repository
                    </a>
                  )}
                </p>
              </div>
            )}
            {graph && scene && run && (
              <>
                {pinnedLine && onMap && (
                  <PinnedLineChip
                    from={nodesById.get(pinnedLine.from)?.name ?? pinnedLine.from}
                    to={nodesById.get(pinnedLine.to)?.name ?? pinnedLine.to}
                    rightInset={rightInset}
                    onClear={() => pinLine(null)}
                  />
                )}
                <div className={fadeChrome(dive.stage === 'map')} inert={dive.stage !== 'map'}>
                  <MapToolbar hint={!logOpen && !codeNode} />
                </div>
                {page?.hasCanvas && (
                  <div className={fadeChrome(dive.stage === 'file')}>
                    <FileBar page={page} onReplay={() => fileCamera.current?.replay()} />
                  </div>
                )}
                {route && dive.stage === 'file' && !page?.hasCanvas && <FileMessage file={route} page={page} />}
                <AnimatePresence>
                  {logOpen && (
                    <ObservationLog
                      key={run.question}
                      run={run}
                      file={agentRun.file}
                      scene={scene}
                      nodesById={nodesById}
                      onExit={exitRun}
                    />
                  )}
                </AnimatePresence>
                <AnimatePresence>
                  {codeNode && (
                    <CodePanel
                      key="code"
                      node={codeNode}
                      colour={scene.colourOf(codeNode)}
                      quote={codePanel?.quote ?? null}
                      graphifyBusy={busy}
                      onGraphify={
                        codeNode.type === 'external' || codeNode.file === dive.mounted
                          ? undefined
                          : () => goToFile(codeNode.file)
                      }
                      onClose={clearSelection}
                    />
                  )}
                </AnimatePresence>
              </>
            )}
          </main>
        </div>
        {graph && <StatusBar graph={graph} />}
        {graph && scene && <CommandPalette nodes={graph.nodes} scene={scene} onPick={pick} />}
      </div>
    </MotionConfig>
  )
}
