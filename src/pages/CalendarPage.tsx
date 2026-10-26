import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox } from 'lucide-react'
import {
  addDays,
  api,
  daysBetween,
  errorMessage,
  formatHours,
  isOverdue,
  todayISO,
  type Card,
  type CardPatch,
  type Person,
} from '../lib/api'
import { useMe } from '../lib/me'
import { useLabels } from '../lib/labels'
import { useAutoRefresh } from '../lib/useAutoRefresh'
import { CardTile } from '../components/Board'
import CardDrawer from '../components/CardDrawer'
import { Avatar, ErrorNote, PageHeader, Spinner } from '../components/ui'
import { PersonFilter } from '../components/pickers'
import { matchesPeople } from '../lib/filters'

/**
 * `/calendar` (#11) — every task with a date, across the workspaces you can see, in
 * three views over the same records:
 *   Timeline  start→due bars, one row per person (drag to move, drag the end to resize)
 *   Month     tasks on their due date
 *   Week      a column per day — a kanban of days / daily task list
 * Rescheduling here edits the task itself, so the project board shows it too.
 */

type View = 'timeline' | 'month' | 'week'
const VIEWS: [View, string][] = [
  ['timeline', 'Timeline'],
  ['month', 'Month'],
  ['week', 'Week'],
]
const VIEW_KEY = 'kanban.calendarView'
const DAY_PX = 44
const TIMELINE_DAYS = 28

function mondayOf(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7 // Monday = 0
  return addDays(iso, -dow)
}

function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`
}

function addMonths(iso: string, n: number) {
  const [y, m] = iso.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/** The visible date range for a view around the anchor date. */
function rangeFor(view: View, anchor: string) {
  if (view === 'week') {
    const from = mondayOf(anchor)
    return { from, to: addDays(from, 6) }
  }
  if (view === 'timeline') {
    const from = mondayOf(anchor)
    return { from, to: addDays(from, TIMELINE_DAYS - 1) }
  }
  const first = monthStart(anchor)
  const from = mondayOf(first)
  const last = addDays(addMonths(first, 1), -1)
  return { from, to: addDays(mondayOf(last), 6) }
}

function stepAnchor(view: View, anchor: string, dir: 1 | -1) {
  if (view === 'month') return addMonths(monthStart(anchor), dir)
  return addDays(anchor, dir * (view === 'week' ? 7 : TIMELINE_DAYS))
}

const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts)
}

function rangeTitle(view: View, anchor: string, from: string, to: string) {
  if (view === 'month') return fmt(monthStart(anchor), { month: 'long', year: 'numeric' })
  return `${fmt(from, { day: 'numeric', month: 'short' })} – ${fmt(to, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

const dayList = (from: string, to: string) => Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i))

/** Same rule as the API: planned hours split across assignees; done tasks don't count. */
function hourTotals(cards: Card[]) {
  const byPerson: Record<string, number> = {}
  let overall = 0
  let unassigned = 0
  for (const c of cards) {
    if (c.column === 'done' || !c.plannedHours) continue
    overall += c.plannedHours
    if (!c.assigneeEmails.length) unassigned += c.plannedHours
    for (const e of c.assigneeEmails) byPerson[e] = (byPerson[e] || 0) + c.plannedHours / c.assigneeEmails.length
  }
  return { overall, unassigned, byPerson }
}

/** New dates when a task is dropped on `day`: the due date moves there, keeping the length. */
function dropDates(card: Card, day: string): CardPatch {
  if (card.dueDate && card.startDate) {
    const shift = daysBetween(card.dueDate, day)
    return { startDate: addDays(card.startDate, shift), dueDate: day }
  }
  return { dueDate: day }
}

export default function CalendarPage() {
  const { me } = useMe()
  const { labels } = useLabels()
  const [params, setParams] = useSearchParams()
  const openCardId = params.get('card')

  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY)
      return v === 'month' || v === 'week' || v === 'timeline' ? v : 'timeline'
    } catch {
      return 'timeline'
    }
  })
  const [anchor, setAnchor] = useState(todayISO())
  const [workspaceId, setWorkspaceId] = useState('')
  const [labelId, setLabelId] = useState('')
  const [circles, setCircles] = useState<string[]>([])
  const [cards, setCards] = useState<Card[] | null>(null)
  const [unscheduled, setUnscheduled] = useState<Card[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [error, setError] = useState('')

  const { from, to } = rangeFor(view, anchor)

  const load = useCallback(
    async (background = false) => {
      try {
        const r = await api.calendar({ from, to, workspaceId, labelId })
        setCards(r.cards)
        setUnscheduled(r.unscheduled)
        setPeople(r.people)
        setError('')
      } catch (err) {
        if (!background) setError(errorMessage(err, 'Could not load the calendar.'))
      }
    },
    [from, to, workspaceId, labelId],
  )

  useEffect(() => {
    void load()
  }, [load])
  useAutoRefresh(() => load(true))

  const chooseView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // Remembering the view is a convenience only.
    }
  }

  const visible = useMemo(() => (cards ?? []).filter((c) => matchesPeople(c.assigneeEmails, circles)), [cards, circles])
  const tray = useMemo(() => unscheduled.filter((c) => matchesPeople(c.assigneeEmails, circles)), [unscheduled, circles])
  const totals = useMemo(() => hourTotals(visible), [visible])

  /** Optimistic reschedule; the server's answer (or the old card) wins. */
  const reschedule = async (card: Card, patch: CardPatch) => {
    const before = { cards, unscheduled }
    const moved = { ...card, ...patch } as Card
    setCards((prev) => [...(prev ?? []).filter((c) => c.id !== card.id), moved])
    setUnscheduled((prev) => prev.filter((c) => c.id !== card.id))
    setError('')
    try {
      const { card: saved } = await api.updateCard(card.id, patch)
      setCards((prev) => (prev ?? []).map((c) => (c.id === saved.id ? { ...saved, projectName: card.projectName } : c)))
    } catch (err) {
      setCards(before.cards)
      setUnscheduled(before.unscheduled)
      setError(errorMessage(err, 'Could not reschedule.'))
    }
  }

  const open = (id: string) => setParams({ card: id })
  const byId = useMemo(() => Object.fromEntries([...(cards ?? []), ...unscheduled].map((c) => [c.id, c])), [cards, unscheduled])

  return (
    <>
      <PageHeader
        title="Calendar"
        actions={
          <div className="flex items-center gap-1 border border-line p-0.5" role="tablist" aria-label="View">
            {VIEWS.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => chooseView(id)}
                className={`px-3 py-1.5 text-sm transition ${view === id ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="btn-ghost border border-line-strong px-2" onClick={() => setAnchor(stepAnchor(view, anchor, -1))} aria-label="Previous">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button className="btn-ghost border border-line-strong" onClick={() => setAnchor(todayISO())}>Today</button>
        <button className="btn-ghost border border-line-strong px-2" onClick={() => setAnchor(stepAnchor(view, anchor, 1))} aria-label="Next">
          <ChevronRight className="h-4 w-4" />
        </button>
        <span className="px-2 font-display text-lg text-fg">{rangeTitle(view, anchor, from, to)}</span>
        <span className="flex-1" />
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
      </div>
      <div className="mb-4">
        <PersonFilter people={people} value={circles} onChange={setCircles} />
      </div>

      <ErrorNote message={error} />

      {!cards ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_17rem]">
          <div className="min-w-0">
            {view === 'timeline' ? (
              <Timeline from={from} to={to} cards={visible} people={people} circles={circles} canEdit={me.canEdit} onOpen={open} onReschedule={reschedule} />
            ) : (
              <DayDnd byId={byId} canEdit={me.canEdit} onDrop={(card, day) => void reschedule(card, day ? dropDates(card, day) : { startDate: null, dueDate: null })}>
                {view === 'month' ? (
                  <Month from={from} to={to} anchor={anchor} cards={visible} canEdit={me.canEdit} onOpen={open} />
                ) : (
                  <Week from={from} to={to} cards={visible} people={people} canEdit={me.canEdit} onOpen={open} />
                )}
                <Tray cards={tray} people={people} canEdit={me.canEdit} onOpen={open} droppable />
              </DayDnd>
            )}
            {view === 'timeline' && <Tray cards={tray} people={people} canEdit={false} onOpen={open} hint="Drag these onto a day in Month or Week view to schedule them." />}
          </div>
          <Totals totals={totals} people={people} />
        </div>
      )}

      {openCardId && (
        <CardDrawer
          key={openCardId}
          cardId={openCardId}
          people={people}
          onClose={() => setParams({})}
          onChange={() => void load(true)}
          onDelete={() => {
            setParams({})
            void load(true)
          }}
          onDuplicated={(copy) => {
            void load(true)
            setParams({ card: copy.id })
          }}
        />
      )}
    </>
  )
}

// --- month & week: drag a task onto a day -------------------------------------------

function DayDnd({
  byId,
  canEdit,
  onDrop,
  children,
}: {
  byId: Record<string, Card>
  canEdit: boolean
  onDrop: (card: Card, day: string | null) => void
  children: ReactNode
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const none = useSensors()
  const end = ({ active, over }: DragEndEvent) => {
    const card = byId[String(active.id)]
    if (!card || !over) return
    const target = String(over.id)
    if (target === 'tray') {
      if (card.dueDate) onDrop(card, null)
      return
    }
    const day = target.replace(/^day:/, '')
    if (day !== card.dueDate) onDrop(card, day)
  }
  return (
    <DndContext sensors={canEdit ? sensors : none} onDragEnd={end}>
      {children}
    </DndContext>
  )
}

function DraggableCard({ card, canEdit, onOpen, children }: { card: Card; canEdit: boolean; onOpen: (id: string) => void; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id, disabled: !canEdit })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(card.id)}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30, position: 'relative' } : undefined}
      className={isDragging ? 'opacity-70' : ''}
    >
      {children}
    </div>
  )
}

function DayCell({ day, className, children }: { day: string; className: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day}` })
  return (
    <div ref={setNodeRef} className={`${className} ${isOver ? 'bg-accent/5 ring-1 ring-inset ring-accent/40' : ''}`}>
      {children}
    </div>
  )
}

/** Month-grid chip: task on the first line, its project underneath. */
function Chip({ card }: { card: Card }) {
  const tone = card.delayed
    ? 'border-amber-400/60 bg-amber-400/10 text-amber-900'
    : isOverdue(card)
      ? 'border-red-400/50 bg-red-500/10 text-red-800'
      : card.column === 'done'
        ? 'border-line bg-canvas text-fg-subtle line-through'
        : 'border-line bg-surface text-fg hover:border-accent/50'
  return (
    <div
      className={`cursor-pointer border px-1.5 py-0.5 text-[11px] ${tone}`}
      title={`${card.key ?? ''} ${card.title}${card.projectName ? ` · ${card.projectName}` : ''}${card.delayed ? ` — delayed: ${card.delayReason}` : ''}`}
    >
      <div className="flex items-center gap-1 truncate">
        {card.delayed && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-700" />}
        {card.key && <span className="shrink-0 font-mono text-[10px] text-fg-subtle">{card.key}</span>}
        <span className="truncate">{card.title}</span>
      </div>
      {card.projectName && (
        <Link to={`/p/${card.projectId}`} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} className="block truncate text-[10px] opacity-60 hover:underline hover:opacity-100" title={`Open project: ${card.projectName}`}>
          {card.projectName}
        </Link>
      )}
    </div>
  )
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function Month({ from, to, anchor, cards, canEdit, onOpen }: { from: string; to: string; anchor: string; cards: Card[]; canEdit: boolean; onOpen: (id: string) => void }) {
  const days = dayList(from, to)
  const month = anchor.slice(0, 7)
  const today = todayISO()
  const due = (day: string) => cards.filter((c) => c.dueDate === day)
  return (
    <div className="overflow-x-auto">
      <div className="glass grid min-w-[720px] grid-cols-7">
        {WEEKDAYS.map((d) => (
          <div key={d} className="border-b border-line px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-fg-subtle">{d}</div>
        ))}
        {days.map((day) => {
          const list = due(day)
          return (
            <DayCell key={day} day={day} className={`min-h-28 border-b border-r border-line p-1.5 ${day.slice(0, 7) !== month ? 'bg-canvas' : ''}`}>
              <div className={`mb-1 font-mono text-[11px] ${day === today ? 'inline-block bg-accent px-1 text-accent-fg' : day.slice(0, 7) === month ? 'text-fg-muted' : 'text-fg-subtle'}`}>
                {Number(day.slice(8))}
              </div>
              <div className="space-y-1">
                {list.map((c) => (
                  <DraggableCard key={c.id} card={c} canEdit={canEdit} onOpen={onOpen}>
                    <Chip card={c} />
                  </DraggableCard>
                ))}
              </div>
            </DayCell>
          )
        })}
      </div>
    </div>
  )
}

/** A column per day — the "daily task list" / kanban of days. */
function Week({ from, to, cards, people, canEdit, onOpen }: { from: string; to: string; cards: Card[]; people: Person[]; canEdit: boolean; onOpen: (id: string) => void }) {
  const today = todayISO()
  return (
    <div className="flex gap-2 overflow-x-auto pb-4">
      {dayList(from, to).map((day, i) => {
        const list = cards.filter((c) => c.dueDate === day)
        const hours = hourTotals(list).overall
        return (
          <DayCell key={day} day={day} className="glass flex w-56 shrink-0 flex-col sm:w-auto sm:min-w-[8.5rem] sm:flex-1">
            <header className={`flex items-baseline justify-between px-3 py-2.5 ${day === today ? 'border-b border-accent/60' : 'border-b border-line'}`}>
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-fg-muted">
                {WEEKDAYS[i]} <span className={day === today ? 'text-accent' : 'text-fg-subtle'}>{fmt(day, { day: 'numeric', month: 'short' })}</span>
              </span>
              {hours > 0 && <span className="font-mono text-[11px] text-fg-subtle">{formatHours(hours)}</span>}
            </header>
            <div className="flex min-h-32 flex-1 flex-col gap-2 p-2">
              {list.map((c) => (
                <DraggableCard key={c.id} card={c} canEdit={canEdit} onOpen={onOpen}>
                  <CardTile card={c} people={people} compact showProject />
                </DraggableCard>
              ))}
            </div>
          </DayCell>
        )
      })}
    </div>
  )
}

/** Open tasks with no date. In Month/Week they can be dragged onto a day; dropping a task here clears its dates. */
function Tray({ cards, people, canEdit, onOpen, droppable = false, hint }: { cards: Card[]; people: Person[]; canEdit: boolean; onOpen: (id: string) => void; droppable?: boolean; hint?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'tray', disabled: !droppable })
  return (
    <section ref={setNodeRef} className={`glass mt-4 p-3 ${isOver ? 'ring-1 ring-accent/40' : ''}`}>
      <h2 className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
        <Inbox className="h-3.5 w-3.5" /> Unscheduled <span className="text-fg-subtle">{cards.length}</span>
      </h2>
      {hint && cards.length > 0 && <p className="mb-2 text-xs text-fg-subtle">{hint}</p>}
      {cards.length === 0 ? (
        <p className="text-xs text-fg-subtle">Every open task has a date.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) =>
            droppable ? (
              <DraggableCard key={c.id} card={c} canEdit={canEdit} onOpen={onOpen}>
                <CardTile card={c} people={people} compact showProject />
              </DraggableCard>
            ) : (
              <div key={c.id} onClick={() => onOpen(c.id)}>
                <CardTile card={c} people={people} compact showProject />
              </div>
            ),
          )}
        </div>
      )}
    </section>
  )
}

// --- timeline: one row per person, start→due bars ----------------------------------

type Drag = { card: Card; mode: 'move' | 'resize'; startX: number; delta: number }

function Timeline({
  from,
  to,
  cards,
  people,
  circles,
  canEdit,
  onOpen,
  onReschedule,
}: {
  from: string
  to: string
  cards: Card[]
  people: Person[]
  circles: string[]
  canEdit: boolean
  onOpen: (id: string) => void
  onReschedule: (card: Card, patch: CardPatch) => void
}) {
  const days = dayList(from, to)
  const today = todayISO()
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)

  // Rows: the selected people (or everyone with work in range), then Unassigned.
  const rows = useMemo(() => {
    const emails = circles.filter((c) => c !== 'none')
    const shown = (emails.length ? people.filter((p) => emails.includes(p.email)) : people.filter((p) => cards.some((c) => c.assigneeEmails.includes(p.email))))
    const out: { key: string; person: Person | null; cards: Card[] }[] = shown.map((p) => ({ key: p.email, person: p, cards: cards.filter((c) => c.assigneeEmails.includes(p.email)) }))
    const loose = cards.filter((c) => !c.assigneeEmails.length)
    if (loose.length && (!circles.length || circles.includes('none'))) out.push({ key: 'none', person: null, cards: loose })
    return out
  }, [people, cards, circles])

  const start = (e: ReactPointerEvent, card: Card, mode: Drag['mode']) => {
    if (!canEdit) return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const d = { card, mode, startX: e.clientX, delta: 0 }
    dragRef.current = d
    setDrag(d)
  }
  const moveTo = (e: ReactPointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const delta = Math.round((e.clientX - d.startX) / DAY_PX)
    if (delta !== d.delta) {
      dragRef.current = { ...d, delta }
      setDrag(dragRef.current)
    }
  }
  const finish = (card: Card) => {
    const d = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!d || d.delta === 0) {
      if (!d || Math.abs(d.delta) === 0) onOpen(card.id)
      return
    }
    if (!card.dueDate) return
    if (d.mode === 'move') {
      onReschedule(card, { ...(card.startDate ? { startDate: addDays(card.startDate, d.delta) } : {}), dueDate: addDays(card.dueDate, d.delta) })
    } else {
      const due = addDays(card.dueDate, d.delta)
      const floor = card.startDate || card.dueDate
      onReschedule(card, { dueDate: due < floor ? floor : due, ...(card.startDate ? {} : due < card.dueDate ? {} : { startDate: card.dueDate }) })
    }
  }

  /** Where a bar sits, with any drag in progress applied. */
  const span = (card: Card) => {
    let s = card.startDate || card.dueDate!
    let e = card.dueDate!
    if (drag?.card.id === card.id) {
      if (drag.mode === 'move') {
        s = addDays(s, drag.delta)
        e = addDays(e, drag.delta)
      } else {
        e = addDays(e, drag.delta)
        if (e < s) e = s
      }
    }
    return { s, e }
  }

  /** Stack overlapping bars within a row into lanes. */
  const lanes = (list: Card[]) => {
    const sorted = [...list].sort((a, b) => (a.startDate || a.dueDate!).localeCompare(b.startDate || b.dueDate!))
    const ends: string[] = []
    return sorted.map((c) => {
      const { s, e } = span(c)
      let lane = ends.findIndex((end) => end < s)
      if (lane === -1) lane = ends.length
      ends[lane] = e
      return { card: c, lane }
    })
  }

  if (!rows.length) {
    return <p className="glass p-6 text-sm text-fg-subtle">No dated tasks in this range. Give tasks a start and due date to see them here.</p>
  }

  return (
    <div className="glass overflow-x-auto">
      <div style={{ width: 180 + days.length * DAY_PX }}>
        <div className="sticky top-0 z-10 flex border-b border-line bg-surface">
          <div className="sticky left-0 z-10 w-[180px] shrink-0 bg-surface" />
          {days.map((d) => (
            <div
              key={d}
              style={{ width: DAY_PX }}
              className={`shrink-0 py-1.5 text-center font-mono text-[10px] ${d === today ? 'text-accent' : 'text-fg-subtle'} ${(new Date(d).getUTCDay() + 6) % 7 >= 5 ? 'bg-canvas' : ''}`}
            >
              <div>{fmt(d, { weekday: 'narrow' })}</div>
              <div className="text-[11px]">{Number(d.slice(8))}</div>
            </div>
          ))}
        </div>
        {rows.map((row) => {
          const placed = lanes(row.cards)
          const height = Math.max(1, ...placed.map((p) => p.lane + 1)) * 30 + 12
          const hours = hourTotals(row.cards).byPerson[row.key] ?? hourTotals(row.cards).unassigned
          return (
            <div key={row.key} className="flex border-b border-line">
              <div className="sticky left-0 z-10 flex w-[180px] shrink-0 items-center gap-2 bg-surface px-3 py-2">
                {row.person ? <Avatar name={row.person.name} /> : <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-line-strong text-[10px] text-fg-subtle">?</span>}
                <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{row.person?.name ?? 'Unassigned'}</span>
                {hours > 0 && <span className="font-mono text-[10px] text-fg-subtle">{formatHours(hours)}</span>}
              </div>
              <div className="relative shrink-0" style={{ width: days.length * DAY_PX, height }}>
                {days.map((d, i) => (
                  <div
                    key={d}
                    className={`absolute inset-y-0 border-l border-line ${d === today ? 'bg-accent/5' : ''}`}
                    style={{ left: i * DAY_PX, width: DAY_PX }}
                  />
                ))}
                {placed.map(({ card, lane }) => {
                  const { s, e } = span(card)
                  const left = Math.max(0, daysBetween(from, s)) * DAY_PX
                  const right = Math.min(days.length, daysBetween(from, e) + 1) * DAY_PX
                  if (right <= 0 || left >= days.length * DAY_PX) return null
                  const tone = card.delayed
                    ? 'border-amber-400/70 bg-amber-100 text-amber-900'
                    : isOverdue(card)
                      ? 'border-red-400 bg-red-100 text-red-900'
                      : card.column === 'done'
                        ? 'border-line bg-muted text-fg-subtle line-through'
                        : 'border-accent/50 bg-accent/10 text-fg'
                  return (
                    <div
                      key={card.id}
                      role="button"
                      tabIndex={0}
                      title={`${card.key ?? ''} ${card.title}${card.projectName ? ` · ${card.projectName}` : ''}${card.delayed ? ` — delayed: ${card.delayReason}` : ''}`}
                      onKeyDown={(ev) => ev.key === 'Enter' && onOpen(card.id)}
                      onPointerDown={(ev) => (canEdit ? start(ev, card, 'move') : undefined)}
                      onPointerMove={moveTo}
                      onPointerUp={() => (canEdit ? finish(card) : onOpen(card.id))}
                      className={`absolute flex select-none items-center gap-1 overflow-hidden border px-1.5 text-[11px] ${tone} ${canEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${drag?.card.id === card.id ? 'z-20 shadow-md' : ''}`}
                      style={{ left: left + 1, width: Math.max(right - left - 2, 12), top: 6 + lane * 30, height: 24 }}
                    >
                      {card.delayed && <AlertTriangle className="h-3 w-3 shrink-0" />}
                      {card.key && <span className="shrink-0 font-mono text-[10px] opacity-70">{card.key}</span>}
                      <span className="min-w-0 shrink truncate">{card.title}</span>
                      {card.projectName && (
                        <Link
                          to={`/p/${card.projectId}`}
                          onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                          className="min-w-0 shrink-[2] truncate opacity-60 hover:underline hover:opacity-100"
                          title={`Open project: ${card.projectName}`}
                        >
                          · {card.projectName}
                        </Link>
                      )}
                      {canEdit && (
                        <span
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-black/10"
                          onPointerDown={(ev) => start(ev, card, 'resize')}
                          aria-label="Drag to change the due date"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- totals ----------------------------------------------------------------------------

function Totals({ totals, people }: { totals: ReturnType<typeof hourTotals>; people: Person[] }) {
  const rows = people.map((p) => ({ p, h: totals.byPerson[p.email] || 0 })).filter((r) => r.h > 0).sort((a, b) => b.h - a.h)
  const max = Math.max(1, ...rows.map((r) => r.h), totals.unassigned)
  return (
    <aside className="glass h-fit p-4">
      <h2 className="label">Planned hours in view</h2>
      <p className="mb-4 font-display text-3xl font-semibold text-fg">{formatHours(totals.overall) || '0h'}</p>
      {rows.length === 0 && totals.unassigned === 0 ? (
        <p className="text-xs text-fg-subtle">Add estimates to tasks to see hours here. Done tasks don't count.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map(({ p, h }) => (
            <li key={p.email}>
              <div className="mb-1 flex items-center gap-2 text-sm">
                <Avatar name={p.name} />
                <span className="min-w-0 flex-1 truncate text-fg-muted">{p.name}</span>
                <span className="font-mono text-xs text-fg-muted">{formatHours(h)}</span>
              </div>
              <div className="h-1 bg-muted">
                <div className="h-1 bg-accent" style={{ width: `${(h / max) * 100}%` }} />
              </div>
            </li>
          ))}
          {totals.unassigned > 0 && (
            <li>
              <div className="mb-1 flex items-center justify-between text-sm text-fg-subtle">
                <span>Unassigned</span>
                <span className="font-mono text-xs">{formatHours(totals.unassigned)}</span>
              </div>
              <div className="h-1 bg-muted">
                <div className="h-1 bg-fg-subtle" style={{ width: `${(totals.unassigned / max) * 100}%` }} />
              </div>
            </li>
          )}
        </ul>
      )}
      <p className="mt-4 text-[11px] leading-relaxed text-fg-subtle">
        Planned = estimate + buffer. A task shared by several people is split evenly between them.
      </p>
    </aside>
  )
}
