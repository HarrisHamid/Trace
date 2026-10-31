import { useEffect, useState } from 'react'

import { fetchGraph, streamAsk } from '@/api'
import { GraphView } from '@/components/GraphView'
import { Button } from '@/components/ui/button'
import { useTraceStore } from '@/store'
import type { Graph } from '@/types/contracts/graph.schema'

const DEMO_QUESTION = 'How does login work?'

export default function App() {
  const [graph, setGraph] = useState<Graph | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { agentRun, selectedNode, startRun, addEvent, finishRun } = useTraceStore()

  useEffect(() => {
    fetchGraph().then(setGraph, (error: Error) => setLoadError(error.message))
  }, [])

  async function ask() {
    startRun()
    try {
      await streamAsk(DEMO_QUESTION, (event) => {
        console.log('[trace]', event)
        addEvent(event)
      })
      finishRun('done')
    } catch (error) {
      console.error('[trace]', error)
      finishRun('error')
    }
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <main className="min-w-0 flex-1">
        {graph && <GraphView graph={graph} />}
        {loadError && <p className="p-4 text-destructive">{loadError}</p>}
      </main>
      <aside className="flex w-96 flex-col gap-3 border-l p-4">
        <Button onClick={ask} disabled={agentRun.status === 'running'}>
          Ask: {DEMO_QUESTION}
        </Button>
        <p className="text-sm text-muted-foreground">
          Run: {agentRun.status}. Selected: {selectedNode ?? 'none'}
        </p>
        <ol data-testid="events" className="flex-1 overflow-y-auto font-mono text-xs">
          {agentRun.events.map((event, index) => (
            <li key={index} className="truncate py-0.5">
              {JSON.stringify(event)}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  )
}
