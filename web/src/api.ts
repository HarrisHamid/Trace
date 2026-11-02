import type { AgentEvent } from '@/types/contracts/events.schema'
import type { Graph } from '@/types/contracts/graph.schema'

export async function fetchGraph(): Promise<Graph> {
  const response = await fetch('/api/graph')
  if (!response.ok) throw new Error(`GET /api/graph failed: ${response.status}`)
  return response.json()
}

export async function fetchSource(file: string): Promise<string> {
  const response = await fetch(`/api/source?file=${encodeURIComponent(file)}`)
  if (!response.ok) throw new Error(`GET /api/source failed: ${response.status}`)
  return response.text()
}

// EventSource only does GET, so the SSE stream from POST /api/ask is read by hand.
export async function streamAsk(
  question: string,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
    signal,
  })
  if (!response.ok || !response.body) throw new Error(`POST /api/ask failed: ${response.status}`)

  let buffer = ''
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk.replaceAll('\r\n', '\n')
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const data = frame.split('\n').find((line) => line.startsWith('data:'))
      if (data) onEvent(JSON.parse(data.slice('data:'.length)))
    }
  }
}
