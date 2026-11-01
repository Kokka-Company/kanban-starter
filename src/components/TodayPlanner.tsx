import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Coffee,
  GripVertical,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SkipForward,
  Sun,
  Timer,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { addDays, api, errorMessage, formatDue, isOverdue, todayISO, type Card, type DayPlan, type DayPlanItem } from '../lib/api'
import { autoPlan, byUrgency, formatClock, nowMinutes, schedule, scheduleStart, suggestedPomodoros, toMinutes } from '../lib/dayplan'
import { MODE_LABELS, formatTimer, usePomodoro } from '../lib/usePomodoro'
import { ErrorNote, Spinner } from './ui'

/** One colour per task on the day, in priority order. */
const TASK_COLORS = ['#0284C7', '#D97706', '#7C3AED', '#059669', '#DB2777', '#EA580C', '#2563EB', '#16A34A']
const PX_PER_MIN = 1.15
/** Room above the first hour line so its label isn't cut off. */
const PAD = 10
const COLLAPSE_KEY = 'kanban.today.collapsed'

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function dayLabel(date: string) {
  const today = todayISO()
  if (date === today) return 'Today'
  if (date === addDays(today, 1)) return 'Tomorrow'
  if (date === addDays(today, -1)) return 'Yesterday'
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long' })
}

function longDate(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

/**
 * My tasks → the day window. Pick the tasks for a day and drag them into priority
 * order, give each a number of pomodoros, and "Auto-plan" lays them out on the day's
 * timeline as focus sessions and breaks. The timer runs those sessions and ticks off
 * a pomodoro on the task each time one finishes. Saved per person per day.
 */
export default function TodayPlanner({
  email,
  cards,
  onOpen,
  onCardsChanged,
}: {
  email: string
  /** Everything assigned to you (open and done). */
  cards: Card[]
  onOpen: (cardId: string) => void
  onCardsChanged: () => void
}) {
  const [date, setDate] = useState(todayISO)
  const [plan, setPlan] = useState<DayPlan | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const latest = useRef<DayPlan | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let live = true
    setPlan(null)
    setNote('')
    api
      .dayPlan(date)
      .then((r) => {
        if (!live) return
        latest.current = r.plan
        setPlan(r.plan)
      })
      .catch((err) => live && setError(errorMessage(err, "Could not load the day's plan.")))
    return () => {
      live = false
    }
  }, [date])

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    const p = latest.current
    if (!p) return
    setSaving('saving')
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, date: d, updatedAt, ...input } = p
      await api.saveDayPlan(d, input)
      setSaving('saved')
      setError('')
    } catch (err) {
      setSaving('idle')
      setError(errorMessage(err, "Could not save the day's plan."))
    }
  }, [])

  // Save shortly after the last change (dragging and +/- clicks come in bursts), and on the way out.
  useEffect(() => () => {
    if (saveTimer.current !== undefined) void flush()
  }, [flush])

  const update = useCallback(
    (fn: (p: DayPlan) => DayPlan) => {
      setPlan((prev) => {
        if (!prev) return prev
        const next = fn(prev)
        latest.current = next
        return next
      })
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => void flush(), 900)
    },
    [flush],
  )

  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])
  const items = useMemo(() => plan?.items ?? [], [plan])
  const colorOf = useMemo(() => new Map(items.map((it, i) => [it.cardId, TASK_COLORS[i % TASK_COLORS.length]])), [items])
  const addable = useMemo(
    () => cards.filter((c) => c.column !== 'done' && !items.some((i) => i.cardId === c.id)).sort(byUrgency),
    [cards, items],
  )
  const isToday = date === todayISO()
  const nextCardId = items.find((i) => i.done < i.pomodoros && byId.get(i.cardId)?.column !== 'done')?.cardId ?? null

  const timer = usePomodoro({
    storageKey: `kanban.pomodoro.${email}`,
    settings: plan ?? { focusMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 },
    nextCardId,
    describe: (id) => (id ? byId.get(id)?.title ?? 'Task' : 'Focus session'),
    onFocusDone: (cardId) => {
      // The timer's tasks are today's; only count it if today's plan is the one on screen.
      if (!cardId || latest.current?.date !== todayISO()) return
      update((p) => ({ ...p, items: p.items.map((i) => (i.cardId === cardId ? { ...i, done: i.done + 1, pomodoros: Math.max(i.pomodoros, i.done + 1) } : i)) }))
    },
  })

  const setCollapsedSaved = (v: boolean) => {
    setCollapsed(v)
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0')
    } catch {
      // ignore
    }
  }

  const addItem = (cardId: string) => {
    const card = byId.get(cardId)
    if (!card || !plan) return
    update((p) => ({ ...p, items: [...p.items, { cardId, pomodoros: suggestedPomodoros(card, p.focusMinutes), done: 0 }] }))
  }
  const removeItem = (cardId: string) =>
    update((p) => ({ ...p, items: p.items.filter((i) => i.cardId !== cardId), blocks: p.blocks.filter((b) => b.cardId !== cardId || b.kind !== 'focus') }))
  const setPomodoros = (cardId: string, delta: number) =>
    update((p) => ({ ...p, items: p.items.map((i) => (i.cardId === cardId ? { ...i, pomodoros: Math.max(Math.max(1, i.done), Math.min(16, i.pomodoros + delta)) } : i)) }))
  const move = (from: number, to: number) => update((p) => ({ ...p, items: arrayMove(p.items, from, to) }))

  const runAuto = () => {
    if (!plan) return
    const open = cards.filter((c) => c.column !== 'done')
    const live = plan.items.filter((i) => byId.get(i.cardId)?.column !== 'done')
    const { items: picked, blocks, left } = autoPlan({ ...plan, items: live }, open)
    const kept = plan.items.filter((i) => !live.includes(i)) // finished tasks stay listed, off the timeline
    update((p) => ({ ...p, items: [...picked, ...kept], blocks }))
    const focus = blocks.filter((b) => b.kind === 'focus').length
    setNote(
      !picked.length
        ? 'You have no open tasks to plan.'
        : !focus
          ? `No time left before ${formatClock(plan.endTime)} today. Your priorities are set; move the end time, or plan tomorrow with the arrow.`
          : `${focus} pomodoro${focus === 1 ? '' : 's'} scheduled until ${formatClock(blocks[blocks.length - 1].end)}.` +
            (left ? ` ${left} more didn't fit before ${formatClock(plan.endTime)}.` : ''),
    )
  }

  const reschedule = () => {
    if (!plan) return
    const { blocks, left } = schedule(plan, plan.items.filter((i) => byId.get(i.cardId)?.column !== 'done'), scheduleStart(plan))
    update((p) => ({ ...p, blocks }))
    setNote(left ? `${left} pomodoro${left === 1 ? '' : 's'} didn't fit before ${formatClock(plan.endTime)}.` : '')
  }

  const clear = () => {
    if (!plan || (plan.items.length && !window.confirm(`Clear the plan for ${longDate(date)}?`))) return
    update((p) => ({ ...p, items: [], blocks: [] }))
    setNote('')
  }

  const markDone = async (cardId: string) => {
    try {
      await api.updateCard(cardId, { column: 'done' })
      onCardsChanged()
    } catch (err) {
      setError(errorMessage(err, 'Could not move the task to Done.'))
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = items.findIndex((i) => i.cardId === active.id)
    const to = items.findIndex((i) => i.cardId === over.id)
    if (from >= 0 && to >= 0) move(from, to)
  }

  const planned = items.reduce((s, i) => s + i.pomodoros, 0)
  const finished = items.reduce((s, i) => s + i.done, 0)

  return (
    <section className="glass mb-6 p-4 sm:p-5" aria-label="Day plan">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button className="flex items-center gap-2 text-left" onClick={() => setCollapsedSaved(!collapsed)} aria-expanded={!collapsed}>
          <Sun className="h-5 w-5 text-amber-600" />
          <span className="font-display text-lg font-semibold text-fg">{dayLabel(date)}'s plan</span>
          {collapsed ? <ChevronDown className="h-4 w-4 text-fg-subtle" /> : <ChevronUp className="h-4 w-4 text-fg-subtle" />}
        </button>
        <div className="flex items-center">
          <button className="btn-ghost px-1.5 py-1" onClick={() => setDate((d) => addDays(d, -1))} aria-label="Previous day">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[7.5rem] text-center font-mono text-xs text-fg-muted">{longDate(date)}</span>
          <button className="btn-ghost px-1.5 py-1" onClick={() => setDate((d) => addDays(d, 1))} aria-label="Next day">
            <ChevronRight className="h-4 w-4" />
          </button>
          {!isToday && (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setDate(todayISO())}>
              Today
            </button>
          )}
        </div>
        {plan && items.length > 0 && (
          <span className="font-mono text-xs text-fg-subtle">
            <span className="text-fg">{items.length}</span> task{items.length === 1 ? '' : 's'} · <span className="text-fg">{finished}</span>/{planned} 🍅
          </span>
        )}
        {timer.running && collapsed && (
          <span className="font-mono text-xs text-accent">
            {MODE_LABELS[timer.mode]} {formatTimer(timer.remaining)}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-fg-subtle">
          {saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : ''}
        </span>
      </div>

      {!collapsed && (
        <>
          {!plan ? (
            <div className="py-6">{error ? <ErrorNote message={error} /> : <Spinner />}</div>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <TimeField label="Start" value={plan.startTime} onChange={(v) => update((p) => ({ ...p, startTime: v }))} />
                <TimeField label="End" value={plan.endTime} onChange={(v) => update((p) => ({ ...p, endTime: v }))} />
                <NumberField label="Focus" suffix="min" value={plan.focusMinutes} min={5} max={90} onChange={(v) => update((p) => ({ ...p, focusMinutes: v }))} />
                <NumberField label="Break" suffix="min" value={plan.breakMinutes} min={1} max={30} onChange={(v) => update((p) => ({ ...p, breakMinutes: v }))} />
                <NumberField label="Long break" suffix="min" value={plan.longBreakMinutes} min={5} max={60} onChange={(v) => update((p) => ({ ...p, longBreakMinutes: v }))} />
                <div className="ml-auto flex flex-wrap gap-2">
                  {plan.items.length > 0 && (
                    <button className="btn-ghost border border-line-strong" onClick={clear}>
                      <Trash2 className="h-4 w-4" /> Clear
                    </button>
                  )}
                  <button className="btn-primary" onClick={runAuto} title="Fills an empty day with your most urgent tasks, then lays everything out as pomodoros from now (or the start time)">
                    <Wand2 className="h-4 w-4" /> Auto-plan my day
                  </button>
                </div>
              </div>
              {note && <p className="mt-2 text-sm text-fg-muted">{note}</p>}
              {error && <div className="mt-2"><ErrorNote message={error} /></div>}

              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(15rem,0.8fr)]">
                {/* Priorities */}
                <div>
                  <h3 className="label">Priorities · drag to reorder</h3>
                  {items.length === 0 ? (
                    <p className="border border-dashed border-line px-3 py-6 text-center text-sm text-fg-subtle">
                      Add tasks below, or press <strong className="text-fg">Auto-plan my day</strong> to pick your most urgent ones.
                    </p>
                  ) : (
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                      <SortableContext items={items.map((i) => i.cardId)} strategy={verticalListSortingStrategy}>
                        <ol className="space-y-1.5">
                          {items.map((item, idx) => (
                            <PriorityRow
                              key={item.cardId}
                              rank={idx + 1}
                              item={item}
                              card={byId.get(item.cardId)}
                              color={colorOf.get(item.cardId)!}
                              active={timer.cardId === item.cardId && timer.mode === 'focus' && !timer.idle}
                              canPlay={isToday}
                              onOpen={() => onOpen(item.cardId)}
                              onPlay={() => timer.start(item.cardId)}
                              onDone={() => void markDone(item.cardId)}
                              onRemove={() => removeItem(item.cardId)}
                              onMore={() => setPomodoros(item.cardId, 1)}
                              onLess={() => setPomodoros(item.cardId, -1)}
                            />
                          ))}
                        </ol>
                      </SortableContext>
                    </DndContext>
                  )}
                  <select
                    className="input mt-2"
                    value=""
                    onChange={(e) => e.target.value && addItem(e.target.value)}
                    aria-label="Add a task to the day"
                    disabled={!addable.length}
                  >
                    <option value="">{addable.length ? '+ Add a task to the day…' : 'All your open tasks are on the plan'}</option>
                    {addable.map((c) => (
                      <option key={c.id} value={c.id}>
                        {isOverdue(c) ? '⚠ ' : ''}
                        {c.key ? `${c.key} · ` : ''}
                        {c.title}
                        {c.dueDate ? ` (due ${formatDue(c.dueDate)})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Timeline */}
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="label">Schedule</h3>
                    {plan.blocks.length > 0 && (
                      <button className="btn-ghost -mt-1.5 px-2 py-1 text-xs" onClick={reschedule} title="Lay out what's left from now, keeping your order">
                        <RotateCcw className="h-3.5 w-3.5" /> Reschedule from {isToday ? 'now' : 'start'}
                      </button>
                    )}
                  </div>
                  <DayTimeline
                    plan={plan}
                    isToday={isToday}
                    byId={byId}
                    colorOf={colorOf}
                    activeCardId={timer.mode === 'focus' && !timer.idle ? timer.cardId : null}
                    onStart={isToday ? (id) => timer.start(id) : undefined}
                  />
                </div>

                {/* Timer */}
                <div>
                  <h3 className="label">Pomodoro timer</h3>
                  <PomodoroPanel timer={timer} card={timer.cardId ? byId.get(timer.cardId) : undefined} color={timer.cardId ? colorOf.get(timer.cardId) : undefined} />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input type="time" className="input w-36 py-1.5" value={value} onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && onChange(e.target.value)} />
    </label>
  )
}

function NumberField({ label, suffix, value, min, max, onChange }: { label: string; suffix: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          className="input w-16 py-1.5"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value))
            if (Number.isFinite(n) && n >= min && n <= max) onChange(n)
          }}
        />
        <span className="text-xs text-fg-subtle">{suffix}</span>
      </span>
    </label>
  )
}

function Tomatoes({ done, total }: { done: number; total: number }) {
  return (
    <span className="flex flex-wrap gap-0.5" aria-label={`${done} of ${total} pomodoros done`}>
      {Array.from({ length: Math.max(total, done) }, (_, i) => (
        <span key={i} className={`h-2 w-2 rounded-full ${i < done ? 'bg-red-400' : 'border border-red-400/50'}`} />
      ))}
    </span>
  )
}

function PriorityRow({
  rank,
  item,
  card,
  color,
  active,
  canPlay,
  onOpen,
  onPlay,
  onDone,
  onRemove,
  onMore,
  onLess,
}: {
  rank: number
  item: DayPlanItem
  card: Card | undefined
  color: string
  active: boolean
  canPlay: boolean
  onOpen: () => void
  onPlay: () => void
  onDone: () => void
  onRemove: () => void
  onMore: () => void
  onLess: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.cardId })
  const done = card?.column === 'done'
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, borderLeftColor: color }}
      className={`flex items-center gap-2 border border-l-4 border-line bg-surface px-2 py-2 ${isDragging ? 'z-10 opacity-80 shadow-lg' : ''} ${active ? 'ring-1 ring-accent/60' : ''}`}
    >
      <button className="cursor-grab touch-none text-fg-subtle hover:text-fg active:cursor-grabbing" aria-label="Drag to reorder" {...attributes} {...listeners}>
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="w-4 shrink-0 text-center font-mono text-xs text-fg-subtle">{rank}</span>
      <div className="min-w-0 flex-1">
        <button onClick={onOpen} className={`block w-full truncate text-left text-sm hover:text-accent ${done ? 'text-fg-subtle line-through' : 'text-fg'}`}>
          {card?.key && <span className="mr-1.5 font-mono text-[11px] text-fg-subtle">{card.key}</span>}
          {card?.title ?? 'Task no longer on your list'}
        </button>
        <div className="mt-1 flex items-center gap-2">
          <Tomatoes done={item.done} total={item.pomodoros} />
          {card?.projectName && <span className="truncate font-mono text-[10px] text-fg-subtle">{card.projectName}</span>}
          {card && isOverdue(card) && <span className="font-mono text-[10px] text-red-600">overdue</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <button className="btn-ghost p-1" onClick={onLess} aria-label="One pomodoro fewer" disabled={item.pomodoros <= Math.max(1, item.done)}>
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="w-5 text-center font-mono text-xs text-fg-muted" title="Pomodoros">{item.pomodoros}</span>
        <button className="btn-ghost p-1" onClick={onMore} aria-label="One more pomodoro">
          <Plus className="h-3.5 w-3.5" />
        </button>
        {canPlay && !done && card && (
          <button className="btn-ghost p-1 text-accent" onClick={onPlay} aria-label="Start a pomodoro on this task" title="Start a pomodoro">
            <Play className="h-4 w-4" />
          </button>
        )}
        {!done && card && (
          <button className="btn-ghost p-1 text-emerald-700" onClick={onDone} aria-label="Move to Done" title="Move to Done">
            <Check className="h-4 w-4" />
          </button>
        )}
        <button className="btn-ghost p-1 text-fg-subtle" onClick={onRemove} aria-label="Remove from the day" title="Remove from the day">
          <X className="h-4 w-4" />
        </button>
      </div>
    </li>
  )
}

function DayTimeline({
  plan,
  isToday,
  byId,
  colorOf,
  activeCardId,
  onStart,
}: {
  plan: DayPlan
  isToday: boolean
  byId: Map<string, Card>
  colorOf: Map<string, string>
  activeCardId: string | null
  onStart?: (cardId: string) => void
}) {
  const [now, setNow] = useState(nowMinutes)
  useEffect(() => {
    if (!isToday) return
    const id = window.setInterval(() => setNow(nowMinutes()), 30_000)
    return () => window.clearInterval(id)
  }, [isToday])

  const blocks = plan.blocks
  const starts = [toMinutes(plan.startTime), ...blocks.map((b) => toMinutes(b.start))]
  const ends = [toMinutes(plan.endTime), ...blocks.map((b) => toMinutes(b.end))]
  const lo = Math.floor(Math.min(...starts) / 60) * 60
  const hi = Math.min(24 * 60, Math.ceil(Math.max(...ends) / 60) * 60)
  const height = (hi - lo) * PX_PER_MIN
  const hours = Array.from({ length: (hi - lo) / 60 + 1 }, (_, i) => lo + i * 60)

  // Bring the part of the day that matters into view: now, or the first session.
  const scroller = useRef<HTMLDivElement>(null)
  const firstStart = blocks[0]?.start
  useEffect(() => {
    const target = isToday ? Math.min(nowMinutes(), firstStart ? toMinutes(firstStart) : Infinity) : firstStart ? toMinutes(firstStart) : null
    if (scroller.current && target !== null && Number.isFinite(target)) scroller.current.scrollTop = Math.max(0, PAD + (target - lo) * PX_PER_MIN - 40)
  }, [isToday, firstStart, lo, plan.date])

  // A task's first `done` sessions on the timeline show as finished.
  const doneOf = new Map(plan.items.map((i) => [i.cardId, i.done]))
  const counted = new Map<string, number>()

  return (
    <div ref={scroller} className="relative max-h-[34rem] overflow-y-auto border border-line bg-canvas">
      <div className="relative" style={{ height: height + PAD * 2 }}>
        {hours.map((m) => (
          <div key={m} className="absolute inset-x-0 border-t border-line/70" style={{ top: PAD + (m - lo) * PX_PER_MIN }}>
            <span className="absolute left-1 -translate-y-1/2 bg-surface/90 px-0.5 font-mono text-[10px] text-fg-subtle">{formatClock(`${String(Math.floor(m / 60) % 24).padStart(2, '0')}:00`)}</span>
          </div>
        ))}
        {/* Working hours */}
        <div
          className="absolute left-14 right-1 bg-accent/[0.04]"
          style={{ top: PAD + (toMinutes(plan.startTime) - lo) * PX_PER_MIN, height: Math.max(0, toMinutes(plan.endTime) - toMinutes(plan.startTime)) * PX_PER_MIN }}
        />
        {blocks.length === 0 && (
          <p className="absolute inset-x-14 top-6 text-center text-xs text-fg-subtle">Press Auto-plan to lay your tasks out here.</p>
        )}
        {blocks.map((b, i) => {
          const top = PAD + (toMinutes(b.start) - lo) * PX_PER_MIN
          const h = Math.max(4, (toMinutes(b.end) - toMinutes(b.start)) * PX_PER_MIN - 2)
          if (b.kind !== 'focus') {
            return (
              <div
                key={i}
                className="absolute left-14 right-1 flex items-center gap-1 overflow-hidden px-2 text-[10px] text-fg-subtle"
                style={{ top, height: h, backgroundImage: 'repeating-linear-gradient(135deg, rgba(0,0,0,0.05) 0 4px, transparent 4px 8px)' }}
              >
                {h >= 12 && (
                  <>
                    <Coffee className="h-3 w-3" /> {b.kind === 'long' ? 'Long break' : 'Break'}
                  </>
                )}
              </div>
            )
          }
          const card = b.cardId ? byId.get(b.cardId) : undefined
          const color = (b.cardId && colorOf.get(b.cardId)) || '#64748b'
          const n = (counted.get(b.cardId!) ?? 0) + 1
          counted.set(b.cardId!, n)
          const finished = n <= (doneOf.get(b.cardId!) ?? 0)
          const live = isToday && now >= toMinutes(b.start) && now < toMinutes(b.end)
          const past = isToday && now >= toMinutes(b.end)
          return (
            <button
              key={i}
              type="button"
              disabled={!onStart || !card || card.column === 'done'}
              onClick={() => b.cardId && onStart?.(b.cardId)}
              title={`${formatClock(b.start)}–${formatClock(b.end)} · ${card?.title ?? 'Task'}${onStart ? ' · click to start the timer' : ''}`}
              className={`absolute left-14 right-1 overflow-hidden border-l-[3px] px-2 py-0.5 text-left transition hover:brightness-95 disabled:cursor-default ${past || finished ? 'opacity-50' : ''} ${live || activeCardId === b.cardId ? 'ring-1 ring-fg/40' : ''}`}
              style={{ top, height: h, borderLeftColor: color, backgroundColor: `${color}26` }}
            >
              <span className="flex items-center gap-1.5 truncate text-[11px] leading-tight text-fg">
                <span className="font-mono text-[10px] text-fg-subtle">{formatClock(b.start)}</span>
                {card?.key && <span className="font-mono text-[10px]" style={{ color }}>{card.key}</span>}
                <span className={`truncate ${card?.column === 'done' ? 'line-through opacity-60' : ''}`}>{card?.title ?? 'Task'}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-subtle">{finished ? '✓' : '🍅'}{n}</span>
              </span>
            </button>
          )
        })}
        {isToday && now >= lo && now <= hi && (
          <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: PAD + (now - lo) * PX_PER_MIN }}>
            <span className="h-2 w-2 -translate-x-0.5 rounded-full bg-red-400" />
            <span className="h-px flex-1 bg-red-400/80" />
          </div>
        )}
      </div>
    </div>
  )
}

function PomodoroPanel({ timer, card, color }: { timer: ReturnType<typeof usePomodoro>; card: Card | undefined; color: string | undefined }) {
  const r = 52
  const circumference = 2 * Math.PI * r
  const progress = timer.total ? 1 - timer.remaining / timer.total : 0
  const ring = timer.mode === 'focus' ? color || 'rgb(var(--accent))' : '#059669'
  return (
    <div className="flex flex-col items-center border border-line bg-canvas px-4 py-5">
      <span className={`mb-2 inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] ${timer.mode === 'focus' ? 'text-accent' : 'text-emerald-700'}`}>
        {timer.mode === 'focus' ? <Timer className="h-3.5 w-3.5" /> : <Coffee className="h-3.5 w-3.5" />}
        {MODE_LABELS[timer.mode]}
      </span>
      <div className="relative h-36 w-36">
        <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden="true">
          <circle cx="60" cy="60" r={r} fill="none" stroke="rgb(var(--line))" strokeWidth="6" />
          <circle
            cx="60"
            cy="60"
            r={r}
            fill="none"
            stroke={ring}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            style={{ transition: 'stroke-dashoffset 0.25s linear' }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-mono text-3xl font-medium tabular-nums text-fg" role="timer" aria-live="off">
          {formatTimer(timer.remaining)}
        </span>
      </div>
      <p className="mt-3 min-h-[2.5rem] max-w-full text-center text-sm text-fg-muted">
        {timer.mode === 'focus' ? (
          card ? (
            <>
              {timer.idle && <span className="text-fg-subtle">Up next: </span>}
              {card.key && <span className="mr-1 font-mono text-xs text-fg-subtle">{card.key}</span>}
              {card.title}
            </>
          ) : (
            <span className="text-fg-subtle">Add tasks to the day, or just start a focus session.</span>
          )
        ) : (
          <span className="text-fg-subtle">Step away from the screen for a bit.</span>
        )}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button className="btn-ghost border border-line-strong p-2" onClick={timer.reset} aria-label="Reset" title="Reset">
          <RotateCcw className="h-4 w-4" />
        </button>
        {timer.running ? (
          <button className="btn-primary px-5" onClick={timer.pause}>
            <Pause className="h-4 w-4" /> Pause
          </button>
        ) : (
          <button className="btn-primary px-5" onClick={() => timer.start()}>
            <Play className="h-4 w-4" /> {timer.idle ? 'Start' : 'Resume'}
          </button>
        )}
        <button className="btn-ghost border border-line-strong p-2" onClick={timer.skip} aria-label={timer.mode === 'focus' ? 'Skip to break' : 'Skip break'} title={timer.mode === 'focus' ? 'Skip to break' : 'Skip break'}>
          <SkipForward className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
