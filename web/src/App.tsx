import { useSyncExternalStore } from 'react'

import { Landing } from '@/components/Landing'
import { Workspace } from '@/components/Workspace'
import { isWorkspace, readHash, subscribeToHash } from '@/lib/route'

// Hash routes, because FastAPI's static mount has no SPA fallback and a path like /app would 404 on refresh.
export default function App() {
  const hash = useSyncExternalStore(subscribeToHash, readHash)
  return isWorkspace(hash) ? <Workspace /> : <Landing />
}
