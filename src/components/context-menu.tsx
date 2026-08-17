/**
 * Quick-action popup and confirmation dialog.
 *
 * Both are deliberately plain: a popup positioned at the pointer, and a modal
 * that names exactly what is about to be destroyed. Deleting a node takes its
 * runs and bundles with it, so the count goes in front of you before you agree
 * to it rather than in an undo you have to discover.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { Button } from './ui'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  hint?: string
}

export function ContextMenu({
  x,
  y,
  title,
  items,
  onClose,
}: {
  x: number
  y: number
  title?: string
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // Deferred so the click that opened the menu does not immediately close it.
    const timer = setTimeout(() => document.addEventListener('mousedown', away), 0)
    document.addEventListener('keydown', escape)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [onClose])

  // Keep the menu on screen when opened near an edge.
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 230)
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - (items.length * 32 + 48))

  return (
    <div
      ref={ref}
      style={{ left, top }}
      className="fixed z-50 w-56 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-xl"
    >
      {title ? (
        <div className="truncate border-b border-neutral-800 px-3 py-1.5 text-[11px] uppercase tracking-wide text-neutral-500">
          {title}
        </div>
      ) : null}
      {items.map((item, i) => (
        <button
          key={i}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
          className={cn(
            'block w-full px-3 py-1.5 text-left text-xs transition-colors',
            item.disabled
              ? 'cursor-not-allowed text-neutral-600'
              : item.danger
                ? 'text-red-300 hover:bg-red-950/60'
                : 'text-neutral-200 hover:bg-neutral-800',
          )}
        >
          {item.label}
          {item.hint ? (
            <span className="ml-1.5 text-[10px] text-neutral-600">{item.hint}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: {
  title: string
  body: ReactNode
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onCancel, onConfirm])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl">
        <h2 className="text-sm font-medium text-neutral-100">{title}</h2>
        <div className="mt-2 text-xs leading-relaxed text-neutral-400">{body}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Small prompt for a millimetre distance, used when inserting a splice. */
export function DistancePrompt({
  title,
  body,
  max,
  defaultValue,
  confirmLabel = 'Insert splice',
  onConfirm,
  onCancel,
}: {
  title: string
  body: ReactNode
  max: number
  defaultValue: number
  confirmLabel?: string
  onConfirm: (value: number) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.select()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onCancel])

  const submit = () => {
    const value = Number(ref.current?.value)
    if (Number.isFinite(value) && value > 0 && value < max) onConfirm(Math.round(value))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl">
        <h2 className="text-sm font-medium text-neutral-100">{title}</h2>
        <div className="mt-2 text-xs leading-relaxed text-neutral-400">{body}</div>
        <input
          ref={ref}
          type="number"
          defaultValue={defaultValue}
          min={1}
          max={max - 1}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mt-3 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 focus:border-sky-600 focus:outline-none"
        />
        <p className="mt-1 text-[11px] text-neutral-600">
          Between 1 and {max - 1} mm from the source end.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={submit}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
