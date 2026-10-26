import { createContext, useContext } from 'react'
import type { Label, LabelColor } from './api'

/** The shared label list (#10), loaded once and reused everywhere. */
export const LabelsContext = createContext<{
  labels: Label[]
  colors: LabelColor[]
  reload: () => Promise<void>
} | null>(null)

export function useLabels() {
  const ctx = useContext(LabelsContext)
  if (!ctx) throw new Error('useLabels outside LabelsContext')
  return ctx
}

/**
 * Chip colours. Placeholder greys (three shades, repeated) so the template stays
 * white and grey — swap these for real colours when you brand the board.
 */
export const LABEL_STYLES: Record<LabelColor, string> = {
  slate: 'border-zinc-300 bg-zinc-50 text-zinc-700',
  blue: 'border-zinc-400 bg-zinc-100 text-zinc-800',
  teal: 'border-zinc-500 bg-zinc-200 text-zinc-900',
  green: 'border-zinc-300 bg-zinc-50 text-zinc-700',
  amber: 'border-zinc-400 bg-zinc-100 text-zinc-800',
  orange: 'border-zinc-500 bg-zinc-200 text-zinc-900',
  red: 'border-zinc-300 bg-zinc-50 text-zinc-700',
  pink: 'border-zinc-400 bg-zinc-100 text-zinc-800',
  violet: 'border-zinc-500 bg-zinc-200 text-zinc-900',
}
