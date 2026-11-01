import { useEffect, useRef, useState, type RefObject } from 'react'

import type { FileCamera } from '@/components/FileBlocks'
import type { MapCamera, Plunge } from '@/components/GraphView'
import type { FileGraph } from '@/lib/filegraph'
import { useTraceStore } from '@/store'

// The move between the map and a file's page. The map flies into the file's plate, the plate fades into the file's own code,
// and the code then takes itself apart into blocks. The hash drives all of it, so the button, browser Back and a typed link
// take the same path.

const PLATE_MS = 650
const PLUNGE_MS = 320
const SWAP_MS = 200
const CHROME_MS = 210
const BACK_MS = 400
const HOP_MS = 30

export interface Dive {
  stage: 'map' | 'dive' | 'file' | 'back'
  mounted: string | null
  animated: boolean
  fileShown: boolean
  mapShown: boolean
}

const AT_MAP: Dive = { stage: 'map', mounted: null, animated: false, fileShown: false, mapShown: true }

function atFile(file: string): Dive {
  return { stage: 'file', mounted: file, animated: false, fileShown: true, mapShown: false }
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function plungeFor(page: FileGraph, selected: string | null): Plunge {
  const owned = page.graph.nodes.some((node) => node.id === selected && node.file === page.file)
  return { nodeId: owned ? selected : null, module: page.module.id }
}

interface DiveOptions {
  route: string | null
  ready: boolean
  pageOf: (file: string) => FileGraph | null
  map: RefObject<MapCamera | null>
  file: RefObject<FileCamera | null>
}

export function useDive({ route, ready, pageOf, map, file }: DiveOptions): Dive {
  const [dive, setDive] = useState<Dive>(() => (route ? atFile(route) : AT_MAP))
  const shown = useRef(route)
  const timers = useRef<number[]>([])

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => window.clearTimeout(timer))
  }, [])

  useEffect(() => {
    const previous = shown.current
    if (!ready || previous === route) return
    shown.current = route
    timers.current.forEach((timer) => window.clearTimeout(timer))
    timers.current = []
    const after = (delay: number, action: () => void) => timers.current.push(window.setTimeout(action, delay))
    const change = (patch: Partial<Dive>) => setDive((current) => ({ ...current, ...patch }))
    const { selectedNode, view, enterModule, closeCode } = useTraceStore.getState()
    closeCode()

    if (route && previous) {
      const page = pageOf(route)
      if (!page?.hasCanvas || reducedMotion()) {
        // The hash lives outside React, so this effect is what keeps the page in step with it.
        // oxlint-disable-next-line react/set-state-in-effect
        setDive(atFile(route))
        return
      }
      setDive({ stage: 'dive', mounted: route, animated: true, fileShown: false, mapShown: false })
      after(HOP_MS, () => change({ fileShown: true }))
      after(HOP_MS + SWAP_MS, () => file.current?.reveal())
      after(HOP_MS + SWAP_MS + CHROME_MS, () => change({ stage: 'file' }))
      return
    }

    if (route) {
      const page = pageOf(route)
      if (dive.stage === 'back' && dive.mounted === route) {
        setDive(atFile(route))
        file.current?.reveal()
        return
      }
      if (!page?.hasCanvas || reducedMotion()) {
        setDive(atFile(route))
        return
      }
      const plunge = plungeFor(page, selectedNode)
      const lead = view.module === plunge.module ? 0 : PLATE_MS
      if (lead) enterModule(plunge.module)
      setDive({ stage: 'dive', mounted: route, animated: true, fileShown: false, mapShown: true })
      after(lead, () => map.current?.plungeTo(plunge, PLUNGE_MS))
      after(lead + PLUNGE_MS, () => change({ fileShown: true }))
      after(lead + PLUNGE_MS + SWAP_MS, () => {
        change({ mapShown: false })
        file.current?.reveal()
      })
      after(lead + PLUNGE_MS + SWAP_MS + CHROME_MS, () => change({ stage: 'file' }))
      return
    }

    const page = previous ? pageOf(previous) : null
    if (!page?.hasCanvas) {
      setDive(AT_MAP)
      return
    }
    const module = page.module.id
    if (reducedMotion() || dive.stage === 'dive' || !file.current) {
      setDive(AT_MAP)
      if (view.module !== module) enterModule(module, true)
      map.current?.toPlate(module, BACK_MS)
      return
    }
    const plunge = plungeFor(page, selectedNode)
    if (view.module !== module) enterModule(module, true)
    map.current?.jumpTo(plunge)
    file.current.conceal()
    change({ stage: 'back', mapShown: true })
    after(BACK_MS, () => change({ fileShown: false }))
    after(BACK_MS + SWAP_MS, () => {
      change({ mounted: null, animated: false })
      map.current?.toPlate(module, BACK_MS)
    })
    after(BACK_MS * 2 + SWAP_MS, () => setDive(AT_MAP))
  }, [route, ready, pageOf, map, file, dive])

  return dive
}
