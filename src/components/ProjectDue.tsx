import { CalendarClock, Infinity as InfinityIcon } from 'lucide-react'
import { formatDue, todayISO } from '../lib/api'

/** #12: a project ends on a date, or is ongoing. */
export function ProjectDueField({
  dueDate,
  ongoing,
  onChange,
  idPrefix,
}: {
  dueDate: string | null
  ongoing: boolean
  onChange: (v: { dueDate: string | null; ongoing: boolean }) => void
  idPrefix: string
}) {
  return (
    <div>
      <label className="label" htmlFor={`${idPrefix}-due`}>Project due date</label>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id={`${idPrefix}-due`}
          type="date"
          className="input w-48"
          value={dueDate || ''}
          disabled={ongoing}
          onChange={(e) => onChange({ dueDate: e.target.value || null, ongoing: false })}
        />
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" checked={ongoing} onChange={(e) => onChange({ dueDate: e.target.checked ? null : dueDate, ongoing: e.target.checked })} />
          Ongoing (no end date)
        </label>
      </div>
    </div>
  )
}

/** Small badge: "Due 30 Nov", "Overdue 2 Oct" or "Ongoing". Nothing when neither is set. */
export function ProjectDueBadge({ dueDate, ongoing }: { dueDate: string | null; ongoing: boolean }) {
  if (ongoing) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
        <InfinityIcon className="h-3.5 w-3.5" /> Ongoing
      </span>
    )
  }
  if (!dueDate) return null
  const late = dueDate < todayISO()
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider ${late ? 'text-red-600' : 'text-fg-subtle'}`}>
      <CalendarClock className="h-3.5 w-3.5" /> {late ? 'Overdue' : 'Due'} {formatDue(dueDate)}
    </span>
  )
}
