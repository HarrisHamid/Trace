import { ArrowRight, Check, ChevronRight, CircleX, ExternalLink, FolderGit2, LoaderCircle, Plus, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'

import { addRepo, dismissRepo, fetchRepos, type RepoSummary } from '@/api'
import { Mark } from '@/components/MapChrome'
import { MAP_HASH } from '@/lib/route'
import { cn } from '@/lib/utils'
import { useTraceStore } from '@/store'

const POLL_MS = 1000
// Matches what the server accepts, so a typo is caught before the round trip.
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+?(\.git)?\/?$/
const STEPS = [
  { step: 'cloning', label: 'Clone' },
  { step: 'parsing', label: 'Parse' },
  { step: 'ready', label: 'Ready' },
] as const

function goToMap() {
  window.location.hash = MAP_HASH
}

function working(repo: RepoSummary) {
  return repo.step === 'cloning' || repo.step === 'parsing'
}

function Meta({ repo }: { repo: RepoSummary }) {
  const parts = [
    repo.commit_sha && repo.commit_sha !== 'unknown' ? `@ ${repo.commit_sha.slice(0, 7)}` : null,
    repo.root && repo.root !== '.' ? `root ${repo.root}` : null,
    repo.files !== null ? `${repo.files} files` : null,
    repo.nodes !== null ? `${repo.nodes} nodes` : null,
    repo.edges !== null ? `${repo.edges} edges` : null,
    repo.calls_internal ? `${repo.calls_resolved}/${repo.calls_internal} calls resolved` : null,
  ].filter(Boolean)
  return <p className="truncate font-mono text-[11px] text-muted-foreground">{parts.join(' · ')}</p>
}

function Progress({ repo, since }: { repo: RepoSummary; since: number | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [])
  const at = STEPS.findIndex(({ step }) => step === repo.step)
  return (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      {STEPS.map(({ step, label }, index) => (
        <span key={step} className="flex items-center gap-2">
          {index > 0 && <span className={cn('h-px w-5', index <= at ? 'bg-primary' : 'bg-border')} />}
          <span className={cn('flex items-center gap-1', index < at ? 'text-verified' : index === at ? 'text-foreground' : 'text-muted-foreground')}>
            {index < at ? (
              <Check aria-hidden className="size-3" />
            ) : index === at ? (
              <LoaderCircle aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <span className="size-1.5 rounded-full border border-current" />
            )}
            {label}
          </span>
        </span>
      ))}
      {since !== undefined && <span className="ml-2 text-muted-foreground tabular-nums">{Math.max(0, Math.round((now - since) / 1000))}s</span>}
    </div>
  )
}

interface RowProps {
  repo: RepoSummary
  current: boolean
  since: number | undefined
  onOpen: () => void
  onRetry: () => void
  onDismiss: () => void
}

function RepoRow({ repo, current, since, onOpen, onRetry, onDismiss }: RowProps) {
  const ready = repo.step === 'ready'
  const failed = repo.step === 'failed'
  return (
    <li
      className={cn(
        'group grid grid-cols-[2rem_1fr_auto] items-center gap-x-3.5 px-4 py-3.5 transition-colors',
        ready && 'cursor-pointer hover:bg-accent/40',
        current && 'bg-primary/[0.06]',
      )}
      onClick={ready ? onOpen : undefined}
    >
      <span
        className={cn(
          'grid size-8 place-items-center rounded border',
          failed ? 'border-destructive/40 text-destructive' : current ? 'border-primary/50 text-primary' : 'border-border text-muted-foreground',
        )}
      >
        {failed ? (
          <CircleX aria-hidden className="size-4" />
        ) : working(repo) ? (
          <LoaderCircle aria-hidden className="size-4 animate-spin text-primary motion-reduce:animate-none" />
        ) : (
          <FolderGit2 aria-hidden className="size-4" />
        )}
      </span>
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate font-mono text-[13px] font-semibold">{repo.repo}</h2>
          {current && <span className="shrink-0 rounded-full border border-primary/50 px-1.5 text-[10px] text-primary">Current</span>}
          {repo.recorded > 0 && (
            <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
              {repo.recorded} recorded questions
            </span>
          )}
          {repo.url && (
            <a
              href={repo.url.replace(/\.git$/, '')}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              title="Open on GitHub"
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
            >
              <ExternalLink aria-label="Open on GitHub" className="size-3.5" />
            </a>
          )}
        </div>
        {ready && <Meta repo={repo} />}
        {working(repo) && <Progress repo={repo} since={since} />}
        {failed && <p className="text-xs text-destructive">{repo.error}</p>}
      </div>
      <div className="flex items-center gap-1.5">
        {ready && (
          <button
            onClick={(event) => {
              event.stopPropagation()
              onOpen()
            }}
            className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors group-hover:border-primary/60 group-hover:text-foreground"
          >
            Open
            <ArrowRight aria-hidden className="size-3.5" />
          </button>
        )}
        {failed && (
          <>
            <button
              onClick={onRetry}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCcw aria-hidden className="size-3.5" />
              Try again
            </button>
            <button onClick={onDismiss} title="Dismiss" className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground">
              <X aria-label="Dismiss" className="size-4" />
            </button>
          </>
        )}
      </div>
    </li>
  )
}

function AddRepoForm({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (url: string, root: string | null) => Promise<void>; onCancel: () => void }) {
  const [url, setUrl] = useState('')
  const [root, setRoot] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const clean = url.trim()
    if (!GITHUB_URL.test(clean)) {
      setError('Use a GitHub repo URL like https://github.com/owner/repo.')
      return
    }
    setSending(true)
    setError(null)
    try {
      await onAdd(clean, root.trim() || null)
    } catch (failure) {
      setError((failure as Error).message)
      setSending(false)
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') onCancel()
  }

  return (
    <form onSubmit={submit} onKeyDown={onKeyDown} className="mt-6 rounded border border-primary/40 bg-card p-4">
      <div className="grid grid-cols-[1fr_12rem] gap-3">
        <label className="space-y-1.5">
          <span className="kicker">GitHub URL</span>
          <input
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://github.com/owner/repo"
            spellCheck={false}
            className="block w-full rounded border border-input bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/70"
          />
        </label>
        <label className="space-y-1.5">
          <span className="kicker">Import root</span>
          <input
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            placeholder="auto-detect"
            spellCheck={false}
            className="block w-full rounded border border-input bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/70"
          />
        </label>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        A public Python repo. Trace makes a shallow clone and parses it into a call graph, usually in under a minute. The
        import root is the folder imports start from, such as <span className="font-mono">backend</span> or{' '}
        <span className="font-mono">src</span>.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
          Cancel
        </button>
        <button
          type="submit"
          disabled={sending || busy || !url.trim()}
          title={busy ? 'Another repo is being added' : undefined}
          className="flex items-center gap-1.5 rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
        >
          {sending ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : <Plus aria-hidden className="size-3.5" />}
          Add repository
        </button>
      </div>
    </form>
  )
}

export function RepoPicker() {
  const current = useTraceStore((state) => state.repo)
  const setRepo = useTraceStore((state) => state.setRepo)
  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // When each ingest was first seen, for its timer.
  const [started, setStarted] = useState<Record<string, number>>({})

  const load = useCallback(
    () =>
      fetchRepos().then(
        (listed) => {
          const seenAt = Date.now()
          setStarted((known) => {
            const fresh = listed.filter((repo) => working(repo) && !(repo.id in known))
            return fresh.length ? { ...known, ...Object.fromEntries(fresh.map((repo) => [repo.id, seenAt])) } : known
          })
          setRepos(listed)
          setLoadError(null)
        },
        (error: Error) => setLoadError(error.message),
      ),
    [],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Polls only while something is being added.
  const pending = repos?.some(working) ?? false
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [pending, load])

  const builtinId = repos?.find((repo) => repo.builtin)?.id
  const currentId = current ?? builtinId

  function open(repo: RepoSummary) {
    setRepo(repo.builtin ? null : repo.id)
    goToMap()
  }

  async function add(url: string, root: string | null) {
    await addRepo(url, root)
    setAdding(false)
    await load()
  }

  async function retry(repo: RepoSummary) {
    await dismissRepo(repo.id).catch(() => undefined)
    try {
      await add(repo.url ?? '', repo.root)
    } catch (error) {
      setLoadError((error as Error).message)
    }
  }

  async function dismiss(repo: RepoSummary) {
    await dismissRepo(repo.id).catch(() => undefined)
    await load()
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
        <a href="#/" className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
          <Mark />
          Trace
        </a>
        <span className="h-4 border-l border-border" />
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 font-mono text-xs text-foreground">
          Repositories
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-12">
          <div className="flex items-end justify-between gap-6">
            <div>
              <p className="kicker">Workspace</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Repositories</h1>
              <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
                Pick a codebase to explore, or add a public GitHub repo. Trace parses it into a call graph the agent walks to answer
                questions, and checks every claim against it.
              </p>
            </div>
            {!adding && (
              <button
                onClick={() => setAdding(true)}
                className="flex shrink-0 items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              >
                <Plus aria-hidden className="size-3.5" />
                Add repository
              </button>
            )}
          </div>

          {adding && <AddRepoForm busy={pending} onAdd={add} onCancel={() => setAdding(false)} />}

          {loadError && (
            <p role="alert" className="mt-6 rounded border border-destructive/40 px-3 py-2 text-xs text-destructive">
              {loadError}
            </p>
          )}

          <section className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="kicker">Ingested</h2>
              {repos && <span className="font-mono text-[11px] text-muted-foreground">{repos.filter((repo) => repo.step === 'ready').length} ready</span>}
            </div>
            {repos === null && !loadError ? (
              <p className="rounded border border-border bg-card px-4 py-6 text-center text-xs text-muted-foreground">Loading repositories…</p>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded border border-border bg-card">
                {repos?.map((repo) => (
                  <RepoRow
                    key={repo.id}
                    repo={repo}
                    current={repo.id === currentId && repo.step === 'ready'}
                    since={started[repo.id]}
                    onOpen={() => open(repo)}
                    onRetry={() => void retry(repo)}
                    onDismiss={() => void dismiss(repo)}
                  />
                ))}
              </ul>
            )}
          </section>

          <p className="mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ChevronRight aria-hidden className="size-3" />
            Python only · public GitHub repos · up to 1,500 Python files
          </p>
        </div>
      </main>
    </div>
  )
}
