// The hash is the single source of truth for the page, so links, refresh and browser Back all work.
// No value imports: `make test-web` runs this file directly under node.

export const MAP_HASH = '#/app'
// Where a repo is picked, or added from GitHub. The landing page leads here, and the map's breadcrumb leads back.
export const REPOS_HASH = '#/repos'

const FILE_PREFIX = `${MAP_HASH}/file/`

export function isWorkspace(hash: string) {
  return hash === MAP_HASH || hash.startsWith(`${MAP_HASH}/`)
}

export function isRepos(hash: string) {
  return hash === REPOS_HASH
}

export function fileHash(file: string) {
  return FILE_PREFIX + file.split('/').map(encodeURIComponent).join('/')
}

export function fileRoute(hash: string): string | null {
  if (!hash.startsWith(FILE_PREFIX)) return null
  try {
    return hash.slice(FILE_PREFIX.length).split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
}

export function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

export function readHash() {
  return window.location.hash
}
