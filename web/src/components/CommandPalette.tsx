import { Command } from 'cmdk'
import Fuse from 'fuse.js'
import { useEffect, useMemo, useState } from 'react'

import { NodeGlyph } from '@/components/Glyphs'
import type { GraphNode } from '@/lib/run'
import type { Scene } from '@/lib/scene'
import { useTraceStore } from '@/store'

const MAX_RESULTS = 12
const BROWSE_ORDER: GraphNode['type'][] = ['module', 'route', 'class', 'function', 'dependency', 'external']

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}

interface CommandPaletteProps {
  nodes: GraphNode[]
  scene: Scene
  onPick: (node: GraphNode) => void
}

export function CommandPalette({ nodes, scene, onPick }: CommandPaletteProps) {
  const open = useTraceStore((state) => state.paletteOpen)
  const setOpen = useTraceStore((state) => state.setPaletteOpen)
  const [query, setQuery] = useState('')

  const fuse = useMemo(
    () =>
      new Fuse(nodes, {
        keys: [{ name: 'name', weight: 3 }, 'id', 'docstring'],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [nodes],
  )
  const browse = useMemo(
    () => [...nodes].sort((a, b) => BROWSE_ORDER.indexOf(a.type) - BROWSE_ORDER.indexOf(b.type)),
    [nodes],
  )
  const results = query ? fuse.search(query, { limit: MAX_RESULTS }).map((result) => result.item) : browse.slice(0, MAX_RESULTS)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const opens = event.key === '/' || (event.key === 'k' && (event.metaKey || event.ctrlKey))
      if (!opens || isTyping(event.target)) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setOpen])

  function changeOpen(next: boolean) {
    setOpen(next)
    if (!next) setQuery('')
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={changeOpen}
      label="Jump to a node"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-40 bg-black/50"
      contentClassName="glass fixed top-[18%] left-1/2 z-50 w-[560px] -translate-x-1/2 bg-[rgb(12_14_21/97%)]"
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="Jump to a function, class, route or module"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-80 overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-4 text-xs text-muted-foreground">Nothing on the chart by that name.</Command.Empty>
        {results.map((node) => (
          <Command.Item
            key={node.id}
            value={node.id}
            onSelect={() => {
              changeOpen(false)
              onPick(node)
            }}
            className="flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-xs data-[selected=true]:bg-accent"
          >
            <NodeGlyph type={node.type} colour={scene.colourOf(node)} />
            <span className="truncate">{node.name}</span>
            <span className="ml-auto truncate text-[10px] text-muted-foreground">{node.module}</span>
            <span className="kicker w-20 shrink-0 text-right">{node.type}</span>
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
