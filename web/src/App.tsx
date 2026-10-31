import { useSyncExternalStore } from 'react'

import { Landing } from '@/components/Landing'
import { Workspace } from '@/components/Workspace'

function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

// Hash routes, because FastAPI's static mount has no SPA fallback and a path like /app would 404 on refresh.
export default function App() {
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash)
  return hash === '#/app' ? <Workspace /> : <Landing />
}
