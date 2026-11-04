import { useTraceStore } from '@/store'
import type { AgentEvent } from '@/types/contracts/events.schema'
import type { Graph } from '@/types/contracts/graph.schema'

export interface RepoSummary {
  id: string
  repo: string
  commit_sha: string | null
  url: string | null
  root: string | null
  nodes: number | null
  edges: number | null
  files: number | null
  calls_resolved: number | null
  calls_internal: number | null
  recorded: number
  replays_any: boolean
  builtin: boolean
  step: 'cloning' | 'parsing' | 'ready' | 'failed'
  error: string | null
  added_at: string | null
}

// The repo being explored. Left out, the server uses the one it started with.
function currentRepo() {
  return useTraceStore.getState().repo
}

function withRepo(path: string, params: Record<string, string> = {}) {
  const repo = currentRepo()
  const query = new URLSearchParams(repo ? { ...params, repo } : params).toString()
  return query ? `${path}?${query}` : path
}

// FastAPI puts the reason for a refusal in detail. Anything else falls back to the status.
async function failure(response: Response, what: string) {
  const body = await response.json().catch(() => null)
  return new Error(typeof body?.detail === 'string' ? body.detail : `${what} failed: ${response.status}`)
}

export async function fetchGraph(): Promise<Graph> {
  const response = await fetch(withRepo('/api/graph'))
  if (!response.ok) throw await failure(response, 'GET /api/graph')
  return response.json()
}

export async function fetchSource(file: string): Promise<string> {
  const response = await fetch(withRepo('/api/source', { file }))
  if (!response.ok) throw new Error(`GET /api/source failed: ${response.status}`)
  return response.text()
}

export async function fetchRepos(): Promise<RepoSummary[]> {
  const response = await fetch('/api/repos')
  if (!response.ok) throw await failure(response, 'GET /api/repos')
  return response.json()
}

// Starts the clone and parse. The new repo shows in fetchRepos with its progress.
export async function addRepo(url: string, root: string | null): Promise<RepoSummary> {
  const response = await fetch('/api/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(root ? { url, root } : { url }),
  })
  if (!response.ok) throw await failure(response, 'Adding the repo')
  return response.json()
}

// Dismisses a failed attempt, or deletes an added repo's graph and clone.
export async function removeRepo(id: string): Promise<void> {
  const response = await fetch(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw await failure(response, 'Removing the repo')
}

// EventSource only does GET, so the SSE stream from POST /api/ask is read by hand.
// file is the file the question was asked from, so the agent starts there. Null asks about the whole repo.
export async function streamAsk(
  question: string,
  file: string | null,
  node: string | null,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, ...(file && { file }), ...(node && { node }), ...(currentRepo() && { repo: currentRepo() }) }),
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
