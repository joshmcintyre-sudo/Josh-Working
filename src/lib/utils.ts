import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Millimetres, shown as metres once a run gets long enough to think in metres. */
export function mm(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} m`
  return `${Math.round(value)} mm`
}

export function amps(value: number): string {
  if (value === 0) return '0 A'
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} A`
}

export function pct(value: number): string {
  return `${value.toFixed(2)} %`
}

export function grams(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kg` : `${Math.round(value)} g`
}
