/**
 * Editing state for one loom.
 *
 * Holds the loom in a reducer with an undo stack, recomputes the analysis on
 * every change, and writes through to the repository on a debounce. The
 * analysis is derived, never stored in state — there is one source of truth for
 * a wire size and it is the calculation.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { getRepository } from '~/lib/db'
import { analyseLoom, type LoomAnalysis } from '~/lib/loom/analysis'
import {
  addSegment,
  duplicateEdge,
  duplicateNode,
  insertSpliceInRun,
  removeNode as removeNodeAndLinks,
  removeSegment as removeSegmentAndRefs,
  splitSegment,
} from '~/lib/loom/mutations'
import type { Loom, LoomEdge, LoomNode, LoomSegment, LoomSettings } from '~/lib/loom/types'

const HISTORY_LIMIT = 100

type Action =
  | { type: 'load'; loom: Loom }
  | { type: 'patchLoom'; patch: Partial<Omit<Loom, 'nodes' | 'edges'>> }
  | { type: 'patchSettings'; patch: Partial<LoomSettings> }
  | { type: 'addNode'; node: LoomNode }
  | { type: 'patchNode'; id: string; patch: Partial<LoomNode> }
  | { type: 'removeNode'; id: string }
  | { type: 'addEdge'; edge: LoomEdge }
  | { type: 'patchEdge'; id: string; patch: Partial<LoomEdge> }
  | { type: 'removeEdge'; id: string }
  | { type: 'addSegment'; segment: LoomSegment }
  | { type: 'patchSegment'; id: string; patch: Partial<LoomSegment> }
  | { type: 'removeSegment'; id: string }
  /** A structural edit computed by a mutation function. */
  | { type: 'replace'; loom: Loom }
  | { type: 'undo' }
  | { type: 'redo' }

interface State {
  loom: Loom | null
  past: Loom[]
  future: Loom[]
  /** Bumped on every real change, so the save effect knows to fire. */
  version: number
}

/** Position-only drags would otherwise fill the undo stack with noise. */
function isCoalescable(action: Action): boolean {
  if (action.type !== 'patchNode') return false
  const keys = Object.keys(action.patch)
  return keys.length === 1 && (keys[0] === 'position' || keys[0] === 'formboardPosition')
}

function apply(loom: Loom, action: Action): Loom {
  switch (action.type) {
    case 'patchLoom':
      return { ...loom, ...action.patch }
    case 'patchSettings':
      return { ...loom, settings: { ...loom.settings, ...action.patch } }
    case 'addNode':
      return { ...loom, nodes: [...loom.nodes, action.node] }
    case 'patchNode':
      return {
        ...loom,
        nodes: loom.nodes.map((n) => (n.id === action.id ? { ...n, ...action.patch } : n)),
      }
    case 'removeNode':
      // Runs and bundles touching a deleted node would dangle, so they go too.
      return removeNodeAndLinks(loom, action.id)
    case 'addEdge':
      return { ...loom, edges: [...loom.edges, action.edge] }
    case 'patchEdge':
      return {
        ...loom,
        edges: loom.edges.map((e) => (e.id === action.id ? { ...e, ...action.patch } : e)),
      }
    case 'removeEdge':
      return { ...loom, edges: loom.edges.filter((e) => e.id !== action.id) }
    case 'addSegment':
      return { ...loom, segments: [...(loom.segments ?? []), action.segment] }
    case 'patchSegment':
      return {
        ...loom,
        segments: (loom.segments ?? []).map((s) =>
          s.id === action.id ? { ...s, ...action.patch } : s,
        ),
      }
    case 'removeSegment':
      return removeSegmentAndRefs(loom, action.id)
    case 'replace':
      return action.loom
    default:
      return loom
  }
}

function reducer(state: State, action: Action): State {
  if (action.type === 'load') {
    return { loom: action.loom, past: [], future: [], version: 0 }
  }
  if (!state.loom) return state

  if (action.type === 'undo') {
    const previous = state.past[state.past.length - 1]
    if (!previous) return state
    return {
      loom: previous,
      past: state.past.slice(0, -1),
      future: [state.loom, ...state.future],
      version: state.version + 1,
    }
  }
  if (action.type === 'redo') {
    const next = state.future[0]
    if (!next) return state
    return {
      loom: next,
      past: [...state.past, state.loom],
      future: state.future.slice(1),
      version: state.version + 1,
    }
  }

  const next = apply(state.loom, action)
  if (next === state.loom) return state
  const past = isCoalescable(action)
    ? state.past
    : [...state.past, state.loom].slice(-HISTORY_LIMIT)
  return { loom: next, past, future: [], version: state.version + 1 }
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function useLoom(loomId: string) {
  const [state, dispatch] = useReducer(reducer, {
    loom: null,
    past: [],
    future: [],
    version: 0,
  })
  const loomRef = useRef<Loom | null>(null)
  loomRef.current = state.loom
  const mutate = useCallback((fn: (loom: Loom) => Loom): Loom => {
    const current = loomRef.current
    if (!current) throw new Error('No loom loaded.')
    return fn(current)
  }, [])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const lastSaved = useRef(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    getRepository()
      .then((repo) => repo.getLoom(loomId))
      .then((loom) => {
        if (cancelled) return
        if (!loom) setLoadError(`No loom with id "${loomId}".`)
        else dispatch({ type: 'load', loom })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loomId])

  // Debounced write-through. Dragging a node fires this once, not sixty times.
  useEffect(() => {
    if (!state.loom || state.version === 0 || state.version === lastSaved.current) return
    const loom = state.loom
    const version = state.version
    setSaveState('saving')
    const timer = setTimeout(() => {
      getRepository()
        .then((repo) => repo.saveLoom(loom))
        .then(() => {
          lastSaved.current = version
          setSaveState('saved')
        })
        .catch(() => setSaveState('error'))
    }, 500)
    return () => clearTimeout(timer)
  }, [state.loom, state.version])

  const analysis: LoomAnalysis | null = useMemo(
    () => (state.loom ? analyseLoom(state.loom) : null),
    [state.loom],
  )

  const actions = useMemo(
    () => ({
      patchLoom: (patch: Partial<Omit<Loom, 'nodes' | 'edges'>>) =>
        dispatch({ type: 'patchLoom', patch }),
      patchSettings: (patch: Partial<LoomSettings>) => dispatch({ type: 'patchSettings', patch }),
      addNode: (node: LoomNode) => dispatch({ type: 'addNode', node }),
      patchNode: (id: string, patch: Partial<LoomNode>) => dispatch({ type: 'patchNode', id, patch }),
      removeNode: (id: string) => dispatch({ type: 'removeNode', id }),
      addEdge: (edge: LoomEdge) => dispatch({ type: 'addEdge', edge }),
      patchEdge: (id: string, patch: Partial<LoomEdge>) => dispatch({ type: 'patchEdge', id, patch }),
      removeEdge: (id: string) => dispatch({ type: 'removeEdge', id }),
      addSegment: (segment: LoomSegment) => dispatch({ type: 'addSegment', segment }),
      patchSegment: (id: string, patch: Partial<LoomSegment>) =>
        dispatch({ type: 'patchSegment', id, patch }),
      removeSegment: (id: string) => dispatch({ type: 'removeSegment', id }),
      undo: () => dispatch({ type: 'undo' }),
      redo: () => dispatch({ type: 'redo' }),
    }),
    [],
  )

  /**
   * Structural edits. Each runs a pure mutation against the current loom and
   * replaces it wholesale, so they undo as a single step.
   */
  const structural = useMemo(
    () => ({
      insertSplice: (edgeId: string, distance_mm: number) =>
        dispatch({ type: 'replace', loom: mutate((l) => insertSpliceInRun(l, edgeId, distance_mm).loom) }),
      splitSegmentAt: (segmentId: string, distance_mm: number) =>
        dispatch({ type: 'replace', loom: mutate((l) => splitSegment(l, segmentId, distance_mm).loom) }),
      duplicate: (nodeId: string) =>
        dispatch({ type: 'replace', loom: mutate((l) => duplicateNode(l, nodeId).loom) }),
      duplicateRun: (edgeId: string) =>
        dispatch({ type: 'replace', loom: mutate((l) => duplicateEdge(l, edgeId).loom) }),
      connectBundle: (fromNodeId: string, toNodeId: string, length_mm: number) =>
        dispatch({
          type: 'replace',
          loom: mutate((l) => addSegment(l, fromNodeId, toNodeId, length_mm).loom),
        }),
    }),
    // `mutate` reads the latest loom out of the ref below, so this stays stable.
    [],
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      if (e.shiftKey) actions.redo()
      else actions.undo()
    },
    [actions],
  )

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  return {
    loom: state.loom,
    analysis,
    loading,
    loadError,
    saveState,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    ...actions,
    ...structural,
  }
}

/** Stable, readable ids — "load-3" beats a uuid on a drawing. */
export function nextId(prefix: string, existing: { id: string }[]): string {
  let n = existing.length + 1
  const taken = new Set(existing.map((x) => x.id))
  while (taken.has(`${prefix}-${n}`)) n++
  return `${prefix}-${n}`
}

export function nextCircuitId(edges: LoomEdge[]): string {
  const numbers = edges
    .map((e) => /^C-(\d+)/.exec(e.circuitId)?.[1])
    .filter((x): x is string => Boolean(x))
    .map(Number)
  const next = numbers.length ? Math.max(...numbers) + 1 : 101
  return `C-${next}`
}
