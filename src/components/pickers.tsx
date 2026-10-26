import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react'
import { Check, Plus, Tag, X } from 'lucide-react'
import { api, errorMessage, type Label, type Person } from '../lib/api'
import { LABEL_STYLES, useLabels } from '../lib/labels'
import { Avatar } from './ui'

export function LabelChip({ label, onRemove }: { label: Label; onRemove?: () => void }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1 border px-1.5 py-px font-mono text-[10px] uppercase tracking-wide ${LABEL_STYLES[label.color] || LABEL_STYLES.slate}`}>
      <span className="truncate">{label.name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="opacity-60 hover:opacity-100" aria-label={`Remove ${label.name}`}>
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

/** Label chips for a list of ids; unknown ids (deleted labels) are skipped. */
export function LabelChips({ ids, className = '' }: { ids: string[]; className?: string }) {
  const { labels } = useLabels()
  const shown = ids.map((id) => labels.find((l) => l.id === id)).filter((l): l is Label => Boolean(l))
  if (!shown.length) return null
  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {shown.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
    </div>
  )
}

/** Overlapping avatar circles for a task's assignees (#4). */
export function AvatarStack({ emails, people, max = 3 }: { emails: string[]; people: Person[]; max?: number }) {
  const nameOf = (e: string) => people.find((p) => p.email === e)?.name || e
  const extra = emails.length - max
  return (
    <span className="flex -space-x-1.5" title={emails.map(nameOf).join(', ')}>
      {emails.slice(0, max).map((e) => (
        <span key={e} className="rounded-full ring-2 ring-surface">
          <Avatar name={nameOf(e)} />
        </span>
      ))}
      {extra > 0 && (
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-fg-muted ring-2 ring-surface">
          +{extra}
        </span>
      )}
    </span>
  )
}

/** A small dropdown panel that closes on outside click / Escape. */
function Popover({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div ref={ref} className="glass-solid absolute left-0 top-full z-20 mt-1 max-h-72 w-64 overflow-y-auto p-1 shadow-xl">
      {children}
    </div>
  )
}

/** Pick any number of people (#4). */
export function PeoplePicker({
  value,
  people,
  onChange,
  disabled,
}: {
  value: string[]
  people: Person[]
  onChange: (emails: string[]) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const nameOf = (e: string) => people.find((p) => p.email === e)?.name || e
  const toggle = (email: string) => onChange(value.includes(email) ? value.filter((e) => e !== email) : [...value, email])
  return (
    <div className="relative">
      <div className="flex min-h-[38px] flex-wrap items-center gap-1 border border-line bg-surface px-2 py-1">
        {value.map((e) => (
          <span key={e} className="inline-flex items-center gap-1 bg-muted py-0.5 pl-0.5 pr-1.5 text-xs text-fg">
            <Avatar name={nameOf(e)} /> {nameOf(e)}
            {!disabled && (
              <button type="button" onClick={() => toggle(e)} className="text-fg-subtle hover:text-fg" aria-label={`Remove ${nameOf(e)}`}>
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 px-1 text-xs text-fg-subtle hover:text-accent">
            <Plus className="h-3.5 w-3.5" /> {value.length ? 'Add' : 'Assign people'}
          </button>
        )}
        {disabled && !value.length && <span className="px-1 text-xs text-fg-subtle">Unassigned</span>}
      </div>
      <Popover open={open} onClose={() => setOpen(false)}>
        {people.map((p) => (
          <button
            key={p.email}
            type="button"
            onClick={() => toggle(p.email)}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-fg hover:bg-muted"
          >
            <Avatar name={p.name} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {value.includes(p.email) && <Check className="h-4 w-4 text-accent" />}
          </button>
        ))}
      </Popover>
    </div>
  )
}

/** Pick labels from the shared list, or create a new one by typing it (#10). */
export function LabelPicker({ value, onChange, disabled }: { value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const { labels, reload } = useLabels()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const matches = useMemo(() => labels.filter((l) => l.name.toLowerCase().includes(q.trim().toLowerCase())), [labels, q])
  const exact = labels.some((l) => l.name.toLowerCase() === q.trim().toLowerCase())
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])

  const create = async () => {
    setError('')
    try {
      const { label } = await api.createLabel(q.trim())
      await reload()
      onChange([...value, label.id])
      setQ('')
    } catch (err) {
      setError(errorMessage(err, 'Could not create the label.'))
    }
  }

  const chosen = value.map((id) => labels.find((l) => l.id === id)).filter((l): l is Label => Boolean(l))
  return (
    <div className="relative">
      <div className="flex min-h-[38px] flex-wrap items-center gap-1 border border-line bg-surface px-2 py-1.5">
        {chosen.map((l) => (
          <LabelChip key={l.id} label={l} onRemove={disabled ? undefined : () => toggle(l.id)} />
        ))}
        {!disabled && (
          <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 px-1 text-xs text-fg-subtle hover:text-accent">
            <Tag className="h-3.5 w-3.5" /> {chosen.length ? 'Add' : 'Add labels'}
          </button>
        )}
        {disabled && !chosen.length && <span className="px-1 text-xs text-fg-subtle">No labels</span>}
      </div>
      <Popover open={open} onClose={() => setOpen(false)}>
        <input
          autoFocus
          className="input mb-1 py-1.5"
          placeholder="Find or create a label…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (q.trim() && !exact) void create()
              else if (matches[0]) toggle(matches[0].id)
            }
          }}
        />
        {matches.map((l) => (
          <button key={l.id} type="button" onClick={() => toggle(l.id)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted">
            <span className="min-w-0 flex-1">
              <LabelChip label={l} />
            </span>
            {value.includes(l.id) && <Check className="h-4 w-4 text-accent" />}
          </button>
        ))}
        {q.trim() && !exact && (
          <button type="button" onClick={() => void create()} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm text-accent hover:bg-muted">
            <Plus className="h-4 w-4" /> Create “{q.trim()}”
          </button>
        )}
        {error && <p className="px-2 py-1 text-xs text-red-700">{error}</p>}
      </Popover>
    </div>
  )
}

/**
 * Avatar circles that filter a board or calendar by person (#8). Click to toggle;
 * several can be on at once. `none` is the "Unassigned" circle.
 */
export function PersonFilter({
  people,
  value,
  onChange,
  showUnassigned = true,
}: {
  people: Person[]
  value: string[]
  onChange: (v: string[]) => void
  showUnassigned?: boolean
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  const ring = (on: boolean) =>
    on ? 'ring-2 ring-accent ring-offset-2 ring-offset-canvas' : 'opacity-60 hover:opacity-100'
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by person">
      {people.map((p) => (
        <button
          key={p.email}
          type="button"
          title={p.name}
          aria-pressed={value.includes(p.email)}
          onClick={() => toggle(p.email)}
          className={`rounded-full transition ${ring(value.includes(p.email))}`}
        >
          <Avatar name={p.name} size="md" />
        </button>
      ))}
      {showUnassigned && (
        <button
          type="button"
          title="Unassigned"
          aria-pressed={value.includes('none')}
          onClick={() => toggle('none')}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-line-strong text-[10px] text-fg-subtle transition ${ring(value.includes('none'))}`}
        >
          ?
        </button>
      )}
      {value.length > 0 && (
        <button type="button" onClick={() => onChange([])} className="ml-1 text-xs text-fg-subtle hover:text-fg">
          Clear
        </button>
      )}
    </div>
  )
}
