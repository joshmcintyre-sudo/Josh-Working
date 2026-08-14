/**
 * Small UI primitives in the shadcn idiom — cva variants over Tailwind classes,
 * composed with cn(). Hand-written rather than generated so there is no
 * component registry to keep in sync for six controls.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'

const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ' +
    'disabled:pointer-events-none disabled:opacity-40 whitespace-nowrap',
  {
    variants: {
      variant: {
        primary: 'bg-sky-600 text-white hover:bg-sky-500',
        default: 'bg-neutral-800 text-neutral-100 hover:bg-neutral-700 border border-neutral-700',
        ghost: 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100',
        danger: 'bg-red-900/60 text-red-100 hover:bg-red-800 border border-red-800',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-9 px-3.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
)

export function Button({
  className,
  variant,
  size,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...props} />
}

const inputBase =
  'w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-sm ' +
  'text-neutral-100 placeholder:text-neutral-600 focus:border-sky-600 focus:outline-none ' +
  'focus:ring-1 focus:ring-sky-600 disabled:opacity-50'

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputBase, className)} {...props} />
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(inputBase, 'pr-8', className)} {...props}>
      {children}
    </select>
  )
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputBase, 'min-h-16 resize-y', className)} {...props} />
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('block space-y-1', className)}>
      <span className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      {children}
      {hint ? <span className="block text-[11px] leading-snug text-neutral-500">{hint}</span> : null}
    </label>
  )
}

/**
 * A number field that lets the user clear it mid-edit without the value
 * snapping to 0 or NaN on every keystroke.
 */
export function NumberInput({
  value,
  onValueChange,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number | undefined
  onValueChange: (v: number | undefined) => void
}) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      value={value ?? ''}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') return onValueChange(undefined)
        const n = Number(raw)
        if (!Number.isNaN(n)) onValueChange(n)
      }}
      {...props}
    />
  )
}

const badge = cva('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', {
  variants: {
    tone: {
      neutral: 'bg-neutral-800 text-neutral-300',
      error: 'bg-red-950 text-red-300 ring-1 ring-red-900',
      warning: 'bg-amber-950 text-amber-300 ring-1 ring-amber-900',
      info: 'bg-sky-950 text-sky-300 ring-1 ring-sky-900',
      ok: 'bg-emerald-950 text-emerald-300 ring-1 ring-emerald-900',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />
}

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex h-full min-h-0 flex-col', className)}>
      {title ? (
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-neutral-800 px-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/50 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-neutral-100 tabular-nums">{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-neutral-500">{sub}</div> : null}
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="text-sm text-neutral-400">{title}</p>
      {children ? <div className="text-xs text-neutral-600">{children}</div> : null}
    </div>
  )
}
