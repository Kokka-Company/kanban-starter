import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { initials } from '../lib/api'

export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 className={`h-5 w-5 animate-spin text-accent ${className}`} aria-label="Loading" />
}

export function CenteredMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-md text-center text-fg-muted">
        <h1 className="mb-2 font-display text-2xl text-fg">{title}</h1>
        {children}
      </div>
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  if (!message) return null
  return <p className="border-l-2 border-red-500 bg-red-500/10 px-3 py-2 text-sm text-red-700">{message}</p>
}

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  const dims = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-xs'
  return (
    <span
      title={name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10 font-mono font-medium text-accent ${dims}`}
    >
      {initials(name)}
    </span>
  )
}

export function PageHeader({
  title,
  crumbs,
  actions,
  mark,
}: {
  title: string
  crumbs?: ReactNode
  actions?: ReactNode
  mark?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 items-center gap-4">
        {mark}
        <div className="min-w-0">
          {crumbs && <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{crumbs}</div>}
          <h1 className="truncate font-display text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{title}</h1>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
