import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, CalendarClock, Clock, ListTodo } from 'lucide-react'
import { api, errorMessage, formatHours, isOverdue, type Card, type Column } from '../lib/api'
import { useMe } from '../lib/me'
import { useLabels } from '../lib/labels'
import { useVisiblePeople } from '../lib/people'
import { useAutoRefresh } from '../lib/useAutoRefresh'
import Board from '../components/Board'
import CardDrawer from '../components/CardDrawer'
import { ErrorNote, PageHeader, Spinner } from '../components/ui'

/** Done tasks pile up; the overall board shows only the most recent ones. */
const DONE_SHOWN = 20

/**
 * `/tasks` — one board with everything assigned to a person, across every project
 * and workspace they can see. `?who=<email>` shows someone else's; default is you.
 * Cards are sorted by due date within a column (each project keeps its own order on
 * its own board), and dragging between columns changes the task's status.
 */
export default function MyTasksPage() {
  const { me } = useMe()
  const { labels } = useLabels()
  const people = useVisiblePeople(me)
  const [params, setParams] = useSearchParams()
  const who = params.get('who') || me.email
  const openCardId = params.get('card')

  const [cards, setCards] = useState<Card[] | null>(null)
  const [workspaceId, setWorkspaceId] = useState('')
  const [labelId, setLabelId] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [delayedOnly, setDelayedOnly] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(
    async (background = false) => {
      if (!who) return
      try {
        const r = await api.cards({ assignee: who, workspaceId, labelId })
        setCards(r.cards)
        setError('')
      } catch (err) {
        if (!background) setError(errorMessage(err, 'Could not load the tasks.'))
      }
    },
    [who, workspaceId, labelId],
  )

  useEffect(() => {
    setCards(null)
    void load()
  }, [load])
  useAutoRefresh(() => load(true))

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next)
  }

  // Board sorts by `order`; here that means "soonest due first", undated last.
  const shown = useMemo(() => {
    if (!cards) return []
    const filtered = cards.filter((c) => (!overdueOnly || isOverdue(c)) && (!delayedOnly || c.delayed))
    const done = filtered
      .filter((c) => c.column === 'done')
      .sort((a, b) => b.updatedBy.at.localeCompare(a.updatedBy.at))
      .slice(0, DONE_SHOWN)
    const rest = filtered.filter((c) => c.column !== 'done')
    return [...rest, ...done]
      .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || (a.key || '').localeCompare(b.key || '', undefined, { numeric: true }))
      .map((c, i) => ({ ...c, order: i }))
  }, [cards, overdueOnly, delayedOnly])

  const open = (cards ?? []).filter((c) => c.column !== 'done')
  const stats = {
    open: open.length,
    overdue: open.filter(isOverdue).length,
    delayed: open.filter((c) => c.delayed).length,
    hours: open.reduce((s, c) => s + (c.plannedHours ? c.plannedHours / Math.max(1, c.assigneeEmails.length) : 0), 0),
  }

  /** Only the column changes here; the task keeps its place on its own project board. */
  const move = async (id: string, column: Column) => {
    const card = cards?.find((c) => c.id === id)
    if (!card || card.column === column) return
    const before = cards
    setCards((prev) => prev?.map((c) => (c.id === id ? { ...c, column } : c)) ?? null)
    try {
      const { card: saved } = await api.updateCard(id, { column })
      setCards((prev) => prev?.map((c) => (c.id === id ? { ...saved, projectName: card.projectName } : c)) ?? null)
    } catch (err) {
      setCards(before)
      setError(errorMessage(err, 'Could not move the task.'))
    }
  }

  const person = people.find((p) => p.email === who)
  const title = who === me.email ? 'My tasks' : `${person?.name ?? who}'s tasks`

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <select className="input w-56" value={who} onChange={(e) => setParam('who', e.target.value === me.email ? null : e.target.value)} aria-label="Whose tasks">
            <option value={me.email}>Me ({me.name})</option>
            {people
              .filter((p) => p.email !== me.email)
              .map((p) => (
                <option key={p.email} value={p.email}>{p.name}</option>
              ))}
          </select>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={<ListTodo className="h-4 w-4" />} label="Open" value={String(stats.open)} />
        <Stat icon={<CalendarClock className="h-4 w-4" />} label="Overdue" value={String(stats.overdue)} tone={stats.overdue ? 'text-red-600' : undefined} />
        <Stat icon={<AlertTriangle className="h-4 w-4" />} label="Delayed" value={String(stats.delayed)} tone={stats.delayed ? 'text-amber-700' : undefined} />
        <Stat icon={<Clock className="h-4 w-4" />} label="Planned hours left" value={formatHours(Math.round(stats.hours * 10) / 10) || '0h'} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className="input w-52" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="Workspace">
          <option value="">All workspaces</option>
          {me.workspaces.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        {labels.length > 0 && (
          <select className="input w-44" value={labelId} onChange={(e) => setLabelId(e.target.value)} aria-label="Label">
            <option value="">Any label</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-2 px-2 text-sm text-fg-muted">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          Overdue
        </label>
        <label className="flex items-center gap-2 px-2 text-sm text-fg-muted">
          <input type="checkbox" checked={delayedOnly} onChange={(e) => setDelayedOnly(e.target.checked)} />
          Delayed
        </label>
        <span className="ml-auto text-xs text-fg-subtle">Sorted by due date · Done shows the latest {DONE_SHOWN}</span>
      </div>

      <ErrorNote message={error} />

      {!cards ? (
        <Spinner />
      ) : cards.length === 0 ? (
        <p className="glass p-6 text-sm text-fg-subtle">No tasks assigned{who === me.email ? ' to you' : ''} yet.</p>
      ) : (
        <Board
          cards={shown}
          people={people}
          canEdit={me.canEdit}
          showProject
          onOpen={(id) => setParam('card', id)}
          onMove={(id, column) => void move(id, column)}
        />
      )}

      {openCardId && (
        <CardDrawer
          key={openCardId}
          cardId={openCardId}
          people={people}
          onClose={() => setParam('card', null)}
          onChange={() => void load(true)}
          onDelete={() => {
            setParam('card', null)
            void load(true)
          }}
          onDuplicated={(copy) => {
            void load(true)
            setParam('card', copy.id)
          }}
        />
      )}
    </>
  )
}

function Stat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone?: string }) {
  return (
    <div className="glass px-4 py-3">
      <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
        {icon} {label}
      </div>
      <div className={`font-display text-2xl font-semibold ${tone ?? 'text-fg'}`}>{value}</div>
    </div>
  )
}
