import { useSyncExternalStore } from 'react'

import { Landing } from '@/components/Landing'
import { RepoPicker } from '@/components/RepoPicker'
import { Workspace } from '@/components/Workspace'
import { isRepos, isWorkspace, readHash, subscribeToHash } from '@/lib/route'
import { useTraceStore } from '@/store'

// Hash routes, because FastAPI's static mount has no SPA fallback and a path like /app would 404 on refresh.
export default function App() {
  const hash = useSyncExternalStore(subscribeToHash, readHash)
  const repo = useTraceStore((state) => state.repo)
  if (isRepos(hash)) return <RepoPicker />
  // Keyed on the repo, so switching repos starts the map, its pages and their caches from nothing.
  return isWorkspace(hash) ? <Workspace key={repo ?? ''} /> : <Landing />
}
