import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragMoveEvent } from '@dnd-kit/core'
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
import { addDays, api, errorMessage, formatDue, formatHours, isOverdue, todayISO, type Card, type DayBlock, type DayPlan, type DayPlanItem } from '../lib/api'
import { QUICK_MINUTES, autoPlan, byStart, byUrgency, estimateFollows, estimateFor, formatClock, fromMinutes, nowMinutes, placeFocus, placeWork, schedule, scheduleStart, suggestedPomodoros, timelineRange, toMinutes } from '../lib/dayplan'
import { inside, pointerOf, type Point } from '../lib/pointer'
import { WORK_TAGS, workTag } from '../lib/workTags'
import { useMe } from '../lib/me'
import { MODE_LABELS, formatTimer, usePomodoro } from '../lib/usePomodoro'
import { ErrorNote, Spinner } from './ui'

/** One colour per task on the day, in priority order. */
const TASK_COLORS = ['#0284C7', '#D97706', '#7C3AED', '#059669', '#DB2777', '#EA580C', '#2563EB', '#16A34A']
const PX_PER_MIN = 1.15
/** Room above the first hour line so its label isn't cut off. */
const PAD = 10
const COLLAPSE_KEY = 'kanban.today.collapsed'
/** Time blocks snap to this many minutes. */
const SNAP = 5
/** Set-aside blocks (e.g. a personal break) move and resize in quarter hours. */
const WORK_SNAP = 15

/** What My tasks' board needs to drop cards onto the day plan. */
export type PlannerDropHandle = {
  /** Whether the pointer is over the priorities list or the schedule. */
  accepts: (p: Point) => boolean
  hover: (p: Point | null) => void
  /** On the list: add the card at the row nearest the pointer. On the schedule: book a time block there. */
  drop: (cardId: string, p: Point) => void
}

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
  dropRef,
}: {
  email: string
  /** Everything assigned to you (open and done). */
  cards: Card[]
  onOpen: (cardId: string) => void
  onCardsChanged: () => void
  dropRef?: Ref<PlannerDropHandle>
}) {
  const { me } = useMe()
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
        if (r.plan.rolledFrom && r.plan.items.length) {
          const n = r.plan.items.length
          setNote(`${n} unfinished task${n === 1 ? '' : 's'} rolled over from ${longDate(r.plan.rolledFrom)}. Press Auto-plan to schedule ${n === 1 ? 'it' : 'them'}.`)
        }
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

  // Pomodoros drive the estimate: extend a task or finish it early and its estimate follows.
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  const estimateTimers = useRef(new Map<string, number>())
  const setEstimateTo = useCallback(
    (cardId: string, pomodoros: number, focusMinutes: number) => {
      const card = byIdRef.current.get(cardId)
      if (!card || pomodoros < 1) return
      const est = estimateFor(pomodoros, focusMinutes, card.assigneeEmails.length, me.estimateBuffer)
      // +/- clicks come in bursts; save once they stop.
      window.clearTimeout(estimateTimers.current.get(cardId))
      estimateTimers.current.set(
        cardId,
        window.setTimeout(async () => {
          estimateTimers.current.delete(cardId)
          if (byIdRef.current.get(cardId)?.estimateHours === est) return
          try {
            await api.updateCard(cardId, { estimateHours: est })
            setNote(`${card.key || card.title}: estimate is now ${formatHours(est)} (${pomodoros} 🍅).`)
            onCardsChanged()
          } catch (err) {
            setError(errorMessage(err, "Could not update the task's estimate."))
          }
        }, 900),
      )
    },
    [me.estimateBuffer, onCardsChanged],
  )

  const timer = usePomodoro({
    storageKey: `kanban.pomodoro.${email}`,
    settings: plan ?? { focusMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 4 },
    nextCardId,
    describe: (id) => (id ? byId.get(id)?.title ?? 'Task' : 'Focus session'),
    focusMinutesFor: (id) => (id && latest.current?.items.find((i) => i.cardId === id)?.quick ? QUICK_MINUTES : null),
    onFocusDone: (cardId) => {
      // The timer's tasks are today's; only count it if today's plan is the one on screen.
      const p = latest.current
      if (!cardId || p?.date !== todayISO()) return
      const item = p.items.find((i) => i.cardId === cardId)
      const card = byIdRef.current.get(cardId)
      // Working past the planned sessions extends the task, and its estimate (not for 5-minute tasks).
      if (item && card && !item.quick && item.done + 1 > item.pomodoros && estimateFollows(card, p.focusMinutes, item.pomodoros, item.done + 1))
        setEstimateTo(cardId, item.done + 1, p.focusMinutes)
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

  const addItem = (cardId: string, at?: number) => {
    const card = byId.get(cardId)
    if (!card || !plan) return
    update((p) => {
      if (p.items.some((i) => i.cardId === cardId)) return p
      const item = { cardId, pomodoros: suggestedPomodoros(card, p.focusMinutes), done: 0 }
      const index = at === undefined ? p.items.length : Math.max(0, Math.min(at, p.items.length))
      return { ...p, items: [...p.items.slice(0, index), item, ...p.items.slice(index)] }
    })
  }

  // Cards dragged in from the board below (or from the priorities onto the schedule).
  const dropZone = useRef<HTMLDivElement>(null)
  const timelineBox = useRef<HTMLDivElement>(null)
  const timelineBody = useRef<HTMLDivElement>(null)
  const [dropHover, setDropHover] = useState<'list' | 'schedule' | null>(null)
  const [ghost, setGhost] = useState<Ghost | null>(null)

  /** The schedule time (snapped) under a pointer height. */
  const minuteAt = (y: number) => {
    const body = timelineBody.current
    const p = latest.current
    if (!body || !p) return null
    const { lo } = timelineRange(p)
    const m = lo + (y - body.getBoundingClientRect().top - PAD) / PX_PER_MIN
    return Math.max(0, Math.round(m / SNAP) * SNAP)
  }

  const showHover = (zone: 'list' | 'schedule' | null, p: Point | null, tag?: string) => {
    setDropHover(zone)
    const m = zone === 'schedule' && p ? minuteAt(p.y) : null
    const length = tag ? workTag(tag).defaultMinutes : (latest.current?.focusMinutes ?? 25)
    setGhost(m === null ? null : { start: tag ? Math.round(m / WORK_SNAP) * WORK_SNAP : m, length, tag })
  }

  /** Put a focus block for the card at `start` on the schedule, adding it to the day if needed. */
  const bookBlock = (cardId: string, start: number) => {
    const p = latest.current
    const card = byId.get(cardId)
    if (!p || !card) return
    if (card.column === 'done') {
      setNote('That task is already done, so it stays off the schedule.')
      return
    }
    const length = p.items.find((i) => i.cardId === cardId)?.quick ? QUICK_MINUTES : p.focusMinutes
    const blocks = placeFocus(p.blocks, cardId, start, length)
    if (!blocks) {
      setNote("That block won't fit before midnight.")
      return
    }
    const booked = blocks.filter((b) => b.kind === 'focus' && b.cardId === cardId).length
    const has = p.items.some((i) => i.cardId === cardId)
    update((prev) => ({
      ...prev,
      blocks,
      items: has
        ? prev.items.map((i) => (i.cardId === cardId ? { ...i, pomodoros: Math.max(i.pomodoros, booked) } : i))
        : [...prev.items, { cardId, pomodoros: Math.max(1, booked), done: 0 }],
    }))
    const placed = blocks.find((b) => b.kind === 'focus' && b.cardId === cardId && !p.blocks.includes(b))
    const at = placed ? toMinutes(placed.start) : start
    setNote(
      `Booked ${formatClock(fromMinutes(at))}–${formatClock(fromMinutes(at + length))} for ${card.key || card.title}.` +
        (at !== start ? ' It slid down to the next free slot.' : ''),
    )
  }

  const moveBlock = (index: number, start: number) => {
    const p = latest.current
    const b = p?.blocks[index]
    if (!p || !b) return
    if (b.kind === 'work') {
      update((prev) => ({ ...prev, blocks: placeWork(prev.blocks.filter((_, i) => i !== index), b.tag!, start, toMinutes(b.end) - toMinutes(b.start)) }))
      return
    }
    if (b.kind !== 'focus' || !b.cardId) return
    const blocks = placeFocus(p.blocks.filter((_, i) => i !== index), b.cardId, start, toMinutes(b.end) - toMinutes(b.start))
    if (!blocks) {
      setNote("That block won't fit before midnight.")
      return
    }
    update((prev) => ({ ...prev, blocks }))
    setNote('')
  }

  /**
   * The 5m button on a schedule block: make the task a 5-minute task (one 5-minute session
   * in place of its remaining pomodoros, no break after) or turn it back into pomodoros.
   * Sessions already finished stay as they were.
   */
  const toggleQuick = (index: number) => {
    const p = latest.current
    const clicked = p?.blocks[index]
    const cardId = clicked?.cardId
    const item = cardId ? p?.items.find((i) => i.cardId === cardId) : undefined
    if (!p || !clicked || !cardId || !item) return
    const card = byId.get(cardId)
    const mine = p.blocks.filter((b) => b.kind === 'focus' && b.cardId === cardId).sort(byStart)
    const finished = mine.slice(0, item.done)
    const open = mine.slice(item.done)
    const others = p.blocks.filter((b) => !(b.kind === 'focus' && b.cardId === cardId))
    if (!item.quick) {
      // Keep one session (the one clicked, unless that one's already finished), 5 minutes long.
      const keep = open.includes(clicked) ? clicked : open[0]
      const blocks = [...others, ...finished, ...(keep ? [{ ...keep, end: fromMinutes(toMinutes(keep.start) + QUICK_MINUTES) }] : [])].sort(byStart)
      update((prev) => ({
        ...prev,
        blocks,
        items: prev.items.map((i) => (i.cardId === cardId ? { ...i, quick: true, pomodoros: i.done + 1 } : i)),
      }))
      setNote(`${card?.key || card?.title || 'Task'} is now a 5-minute task.`)
      return
    }
    // Back to pomodoros: open sessions grow to full length, sliding past anything they'd overlap.
    let blocks: DayBlock[] | null = [...others, ...finished].sort(byStart)
    for (const b of open) {
      blocks = blocks && placeFocus(blocks, cardId, toMinutes(b.start), p.focusMinutes)
      if (!blocks) break
    }
    if (!blocks) {
      setNote("A full pomodoro won't fit there before midnight.")
      return
    }
    const next = blocks
    update((prev) => ({ ...prev, blocks: next, items: prev.items.map((i) => (i.cardId === cardId ? { ...i, quick: undefined } : i)) }))
    setNote(`${card?.key || card?.title || 'Task'} is back to ${p.focusMinutes}-minute pomodoros.`)
  }

  const removeBlock = (index: number) => update((p) => ({ ...p, blocks: p.blocks.filter((_, i) => i !== index) }))

  /** Drag a set-aside block's bottom edge: a new end time, at least a quarter hour after it starts. */
  const resizeBlock = (index: number, end: number) =>
    update((p) => ({
      ...p,
      blocks: p.blocks.map((b, i) => (i === index ? { ...b, end: fromMinutes(Math.max(toMinutes(b.start) + WORK_SNAP, Math.min(end, 23 * 60 + 59))) } : b)),
    }))

  /** Set time aside (e.g. a personal break); Auto-plan and task booking keep it free. */
  const bookWork = (tag: string, start: number) => {
    const p = latest.current
    if (!p) return
    const t = workTag(tag)
    const blocks = placeWork(p.blocks, tag, Math.round(start / WORK_SNAP) * WORK_SNAP, t.defaultMinutes)
    const b = blocks.find((x) => !p.blocks.includes(x))!
    update((prev) => ({ ...prev, blocks }))
    setNote(`${t.name} booked ${formatClock(b.start)}–${formatClock(b.end)}. Drag it to move it, or its bottom edge to resize. Press Reschedule to move pomodoros out of it.`)
  }

  // Dragging a set-aside chip (e.g. Personal Break) onto the schedule. Plain pointer events:
  // the chip lives outside both dnd-kit contexts. A click without a drag books the next free start.
  const [chipDrag, setChipDrag] = useState<{ tag: string; x: number; y: number } | null>(null)
  const startChipDrag = (tag: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX
    const y0 = e.clientY
    let dragging = false
    const move = (ev: PointerEvent) => {
      const p = { x: ev.clientX, y: ev.clientY }
      if (!dragging && Math.hypot(p.x - x0, p.y - y0) < 4) return
      dragging = true
      setChipDrag({ tag, ...p })
      showHover(inside(timelineBox.current, p) ? 'schedule' : null, p, tag)
    }
    const end = (ev: PointerEvent, cancelled: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      setChipDrag(null)
      showHover(null, null)
      if (cancelled) return
      const p = { x: ev.clientX, y: ev.clientY }
      if (!dragging) {
        const plan = latest.current
        if (plan) bookWork(tag, scheduleStart(plan))
      } else if (inside(timelineBox.current, p)) {
        const m = minuteAt(p.y)
        if (m !== null) bookWork(tag, m)
      }
    }
    const up = (ev: PointerEvent) => end(ev, false)
    const cancel = (ev: PointerEvent) => end(ev, true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  const addItemRef = useRef(addItem)
  addItemRef.current = addItem
  const bookRef = useRef(bookBlock)
  bookRef.current = bookBlock
  useImperativeHandle(
    dropRef,
    () => ({
      accepts: (p) => inside(dropZone.current, p) || inside(timelineBox.current, p),
      hover: (p) => showHover(!p ? null : inside(timelineBox.current, p) ? 'schedule' : 'list', p),
      drop: (cardId, p) => {
        showHover(null, null)
        const card = byId.get(cardId)
        if (!card) return
        if (inside(timelineBox.current, p)) {
          const m = minuteAt(p.y)
          if (m !== null) bookRef.current(cardId, m)
          return
        }
        if (card.column === 'done') {
          setNote('That task is already done, so it stays off the plan.')
          return
        }
        if (items.some((i) => i.cardId === cardId)) {
          setNote('That task is already on the plan; drag it within the list to reorder, or onto the schedule to book a time.')
          return
        }
        // Insert before the first row whose middle is below the pointer.
        const rows = Array.from(dropZone.current?.querySelectorAll('ol > li') ?? [])
        const index = rows.findIndex((r) => {
          const b = r.getBoundingClientRect()
          return p.y < b.top + b.height / 2
        })
        addItemRef.current(cardId, index === -1 ? undefined : index)
        setNote('')
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, items],
  )
  const removeItem = (cardId: string) =>
    update((p) => ({ ...p, items: p.items.filter((i) => i.cardId !== cardId), blocks: p.blocks.filter((b) => b.cardId !== cardId || b.kind !== 'focus') }))
  const setPomodoros = (cardId: string, delta: number) => {
    const p = latest.current
    const item = p?.items.find((i) => i.cardId === cardId)
    const card = byId.get(cardId)
    if (!p || !item) return
    const to = Math.max(Math.max(1, item.done), Math.min(16, item.pomodoros + delta))
    if (to === item.pomodoros) return
    if (card && card.column !== 'done' && !item.quick && estimateFollows(card, p.focusMinutes, item.pomodoros, to)) setEstimateTo(cardId, to, p.focusMinutes)
    update((p) => ({ ...p, items: p.items.map((i) => (i.cardId === cardId ? { ...i, pomodoros: to } : i)) }))
  }
  const move = (from: number, to: number) => update((p) => ({ ...p, items: arrayMove(p.items, from, to) }))

  const runAuto = () => {
    if (!plan) return
    const open = cards.filter((c) => c.column !== 'done')
    const live = plan.items.filter((i) => byId.get(i.cardId)?.column !== 'done')
    const { items: picked, blocks, left } = autoPlan({ ...plan, items: live }, open)
    const kept = plan.items.filter((i) => !live.includes(i)) // finished tasks stay listed, off the timeline
    update((p) => ({ ...p, items: [...picked, ...kept], blocks: [...p.blocks.filter((b) => b.kind === 'work'), ...blocks].sort(byStart) }))
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
    const { blocks, left } = schedule(plan, plan.items.filter((i) => byId.get(i.cardId)?.column !== 'done'), scheduleStart(plan), plan.blocks.filter((b) => b.kind === 'work'))
    update((p) => ({ ...p, blocks: [...p.blocks.filter((b) => b.kind === 'work'), ...blocks].sort(byStart) }))
    setNote(left ? `${left} pomodoro${left === 1 ? '' : 's'} didn't fit before ${formatClock(plan.endTime)}.` : '')
  }

  const clear = () => {
    if (!plan || (plan.items.length && !window.confirm(`Clear the plan for ${longDate(date)}?`))) return
    update((p) => ({ ...p, items: [], blocks: [] }))
    setNote('')
  }

  const markDone = async (cardId: string) => {
    const p = latest.current
    const item = p?.items.find((i) => i.cardId === cardId)
    const card = byId.get(cardId)
    const patch: { column: 'done'; estimateHours?: number } = { column: 'done' }
    // Finished in fewer sessions than planned (with the whole task on today's plan), or with no estimate yet: the estimate becomes what it took.
    if (p && item && card && !item.quick && item.done > 0 && (card.estimateHours === null || (item.done < item.pomodoros && estimateFollows(card, p.focusMinutes, item.pomodoros, item.done)))) {
      const est = estimateFor(item.done, p.focusMinutes, card.assigneeEmails.length, me.estimateBuffer)
      if (est !== card.estimateHours) patch.estimateHours = est
    }
    try {
      await api.updateCard(cardId, patch)
      if (patch.estimateHours !== undefined) setNote(`${card!.key || card!.title} done in ${item!.done} 🍅; estimate is now ${formatHours(patch.estimateHours)}.`)
      onCardsChanged()
    } catch (err) {
      setError(errorMessage(err, 'Could not move the task to Done.'))
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  // A priority row dragged across onto the schedule books a time block instead of reordering.
  const onDragMove = (e: DragMoveEvent) => {
    const p = pointerOf(e)
    const over = inside(timelineBox.current, p)
    if (over || dropHover) showHover(over ? 'schedule' : null, p)
  }
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    const p = pointerOf(e)
    showHover(null, null)
    if (p && inside(timelineBox.current, p)) {
      const m = minuteAt(p.y)
      if (m !== null) bookBlock(String(active.id), m)
      return
    }
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
            {timer.quick ? '5-min task' : MODE_LABELS[timer.mode]} {formatTimer(timer.remaining)}
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
                <div
                  ref={dropZone}
                  className={`-m-2 p-2 transition-colors ${dropHover === 'list' ? 'bg-accent/10 outline outline-2 outline-dashed outline-accent/60' : ''}`}
                >
                  <h3 className="label">Priorities · drag to reorder, or drop tasks here from the board</h3>
                  {items.length === 0 ? (
                    <p className="border border-dashed border-line px-3 py-6 text-center text-sm text-fg-subtle">
                      Drag tasks here from the board below, add them from the list, or press <strong className="text-fg">Auto-plan my day</strong> to pick your most urgent ones.
                    </p>
                  ) : (
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={() => showHover(null, null)}>
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
                    <h3 className="label" title="Drop tasks from the board or the priorities to book a time; drag a block to move it">Schedule · drop tasks to book a time</h3>
                    {plan.blocks.some((b) => b.kind !== 'work') && (
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
                    scrollRef={timelineBox}
                    bodyRef={timelineBody}
                    ghost={dropHover === 'schedule' ? ghost : null}
                    onMoveBlock={moveBlock}
                    onRemoveBlock={removeBlock}
                    onResizeBlock={resizeBlock}
                    onToggleQuick={toggleQuick}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {Object.entries(WORK_TAGS).map(([tag, t]) => (
                      <button
                        key={tag}
                        type="button"
                        onPointerDown={startChipDrag(tag)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            bookWork(tag, scheduleStart(plan))
                          }
                        }}
                        className="cursor-grab touch-none select-none border px-2.5 py-1.5 transition hover:brightness-95 active:cursor-grabbing"
                        style={{ borderColor: `${t.accent}66`, backgroundColor: `${t.accent}14` }}
                        title={`Drag onto the schedule to book a ${t.defaultMinutes} min ${t.name}, or click to book the next free slot`}
                        aria-label={`Book a ${t.name}`}
                      >
                        <WorkTagName name={t.name} accent={t.accent} />
                      </button>
                    ))}
                  </div>
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
      {chipDrag && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 border bg-surface/90 px-2.5 py-1.5 shadow-lg"
          style={{ left: chipDrag.x, top: chipDrag.y, borderColor: workTag(chipDrag.tag).accent }}
        >
          <WorkTagName name={workTag(chipDrag.tag).name} accent={workTag(chipDrag.tag).accent} />
        </div>
      )}
    </section>
  )
}

/** A set-aside tag's name with a cup icon, in its accent colour. */
function WorkTagName({ name, accent, small }: { name: string; accent: string; small?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-medium ${small ? 'text-[11px]' : 'text-xs'}`} style={{ color: accent }}>
      <Coffee className={small ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      {name}
    </span>
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

/** A card being dragged over the schedule: where its block would land. */
type Ghost = { start: number; length: number; tag?: string }

function DayTimeline({
  plan,
  isToday,
  byId,
  colorOf,
  activeCardId,
  onStart,
  scrollRef,
  bodyRef,
  ghost,
  onMoveBlock,
  onRemoveBlock,
  onResizeBlock,
  onToggleQuick,
}: {
  plan: DayPlan
  isToday: boolean
  byId: Map<string, Card>
  colorOf: Map<string, string>
  activeCardId: string | null
  onStart?: (cardId: string) => void
  scrollRef: { current: HTMLDivElement | null }
  bodyRef: Ref<HTMLDivElement>
  ghost: Ghost | null
  /** Drag a focus block to a new start time (minutes). */
  onMoveBlock: (index: number, start: number) => void
  onRemoveBlock: (index: number) => void
  /** Drag a work block's bottom edge to a new end time (minutes). */
  onResizeBlock: (index: number, end: number) => void
  /** The 5m button: switch a task between 5-minute sessions and whole pomodoros. */
  onToggleQuick: (index: number) => void
}) {
  const [now, setNow] = useState(nowMinutes)
  useEffect(() => {
    if (!isToday) return
    const id = window.setInterval(() => setNow(nowMinutes()), 30_000)
    return () => window.clearInterval(id)
  }, [isToday])

  const blocks = plan.blocks
  const { lo, hi } = timelineRange(plan)
  const height = (hi - lo) * PX_PER_MIN
  const hours = Array.from({ length: (hi - lo) / 60 + 1 }, (_, i) => lo + i * 60)

  // Bring the part of the day that matters into view: now, or the first session.
  const scroller = useRef<HTMLDivElement | null>(null)
  const setScroller = (el: HTMLDivElement | null) => {
    scroller.current = el
    scrollRef.current = el
  }
  const firstStart = blocks[0]?.start
  useEffect(() => {
    const target = isToday ? Math.min(nowMinutes(), firstStart ? toMinutes(firstStart) : Infinity) : firstStart ? toMinutes(firstStart) : null
    if (scroller.current && target !== null && Number.isFinite(target)) scroller.current.scrollTop = Math.max(0, PAD + (target - lo) * PX_PER_MIN - 40)
    // Only when the day or its first session changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isToday, firstStart, plan.date])

  // Dragging a block up or down (mouse and pen; touch keeps scrolling the schedule).
  const [moving, setMoving] = useState<{ index: number; y0: number; shift: number } | null>(null)
  const [resizing, setResizing] = useState<{ index: number; y0: number; shift: number } | null>(null)
  const moved = useRef(false)
  const shiftOf = (dy: number, snap = SNAP) => Math.round(dy / PX_PER_MIN / snap) * snap

  // Set-aside blocks sit behind the pomodoros; a pomodoro placed inside one is inset so the band shows.
  const work = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.kind === 'work')
  const inWork = (b: DayBlock) => work.some(({ b: w }) => toMinutes(w.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(w.end))

  // A task's first `done` sessions on the timeline show as finished.
  const doneOf = new Map(plan.items.map((i) => [i.cardId, i.done]))
  const quickIds = new Set(plan.items.filter((i) => i.quick).map((i) => i.cardId))
  const counted = new Map<string, number>()

  return (
    <div ref={setScroller} className={`relative max-h-[34rem] overflow-y-auto border bg-canvas transition-colors ${ghost ? 'border-accent/60' : 'border-line'}`}>
      <div ref={bodyRef} className="relative" style={{ height: height + PAD * 2 }}>
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
        {blocks.length === 0 && !ghost && (
          <p className="absolute inset-x-14 top-6 text-center text-xs text-fg-subtle">Press Auto-plan, or drag a task here to book a time.</p>
        )}
        {work.map(({ b, i }) => {
          const t = workTag(b.tag)
          const shift = moving?.index === i ? moving.shift : 0
          const grow = resizing?.index === i ? resizing.shift : 0
          const start = toMinutes(b.start) + shift
          const end = Math.max(toMinutes(b.start) + WORK_SNAP, toMinutes(b.end) + grow) + shift
          const range = `${formatClock(fromMinutes(start))}–${formatClock(fromMinutes(end))}`
          return (
            <div
              key={`w${i}`}
              onPointerDown={(e) => {
                if (e.button !== 0 || e.pointerType === 'touch') return
                e.currentTarget.setPointerCapture(e.pointerId)
                moved.current = false
                setMoving({ index: i, y0: e.clientY, shift: 0 })
              }}
              onPointerMove={(e) => {
                if (moving?.index !== i) return
                const dy = e.clientY - moving.y0
                if (Math.abs(dy) > 4) moved.current = true
                const s = shiftOf(dy, WORK_SNAP)
                if (s !== moving.shift) setMoving({ ...moving, shift: s })
              }}
              onPointerUp={() => {
                if (moving?.index !== i) return
                setMoving(null)
                if (moved.current && moving.shift) onMoveBlock(i, toMinutes(b.start) + moving.shift)
                moved.current = false
              }}
              onPointerCancel={() => setMoving(null)}
              title={`${t.name} · ${range} · drag to move, drag the bottom edge to resize`}
              className={`group absolute left-14 right-1 select-none border-l-[3px] ${shift || grow ? 'z-20 cursor-grabbing' : 'cursor-grab'}`}
              style={{
                top: PAD + (start - lo) * PX_PER_MIN,
                height: Math.max(6, (end - start) * PX_PER_MIN - 2),
                borderLeftColor: t.accent,
                backgroundColor: `${t.accent}12`,
                backgroundImage: `repeating-linear-gradient(135deg, ${t.accent}0d 0 6px, transparent 6px 12px)`,
                outline: `1px solid ${t.accent}33`,
              }}
            >
              <span className="flex items-center gap-1.5 px-1.5 pt-1">
                <WorkTagName name={t.name} accent={t.accent} small />
                <span className="truncate font-mono text-[10px] text-fg-subtle">{range}</span>
              </span>
              <button
                type="button"
                className="absolute right-0.5 top-0.5 z-10 hidden p-0.5 text-fg-subtle hover:text-fg group-hover:block"
                aria-label={`Remove this ${t.name}`}
                title={`Remove this ${t.name}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemoveBlock(i)}
              >
                <X className="h-3 w-3" />
              </button>
              {/* Bottom edge: drag to resize. */}
              <div
                className="absolute inset-x-0 -bottom-1 z-10 h-2.5 cursor-ns-resize"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  if (e.button !== 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setResizing({ index: i, y0: e.clientY, shift: 0 })
                }}
                onPointerMove={(e) => {
                  if (resizing?.index !== i) return
                  const s = shiftOf(e.clientY - resizing.y0, WORK_SNAP)
                  if (s !== resizing.shift) setResizing({ ...resizing, shift: s })
                }}
                onPointerUp={(e) => {
                  e.stopPropagation()
                  if (resizing?.index !== i) return
                  setResizing(null)
                  if (resizing.shift) onResizeBlock(i, toMinutes(b.end) + resizing.shift)
                }}
                onPointerCancel={() => setResizing(null)}
              >
                <span className="mx-auto mt-1 block h-0.5 w-8 opacity-0 transition group-hover:opacity-100" style={{ backgroundColor: t.accent }} />
              </div>
            </div>
          )
        })}
        {blocks.map((b, i) => {
          if (b.kind === 'work') return null
          const shift = moving?.index === i ? moving.shift : 0
          const start = toMinutes(b.start) + shift
          const top = PAD + (start - lo) * PX_PER_MIN
          const h = Math.max(4, (toMinutes(b.end) - toMinutes(b.start)) * PX_PER_MIN - 2)
          if (b.kind !== 'focus') {
            return (
              <div
                key={i}
                className={`absolute ${inWork(b) ? 'left-[4.75rem] right-2' : 'left-14 right-1'} flex items-center gap-1 overflow-hidden px-2 text-[10px] text-fg-subtle`}
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
          const canStart = !!onStart && !!card && card.column !== 'done'
          const quick = !!b.cardId && quickIds.has(b.cardId)
          // A 5-minute block is only a few pixels tall; give it room for its title and the 5m button.
          const shown = quick ? Math.max(h, 18) : h
          const start_ = () => {
            if (canStart && b.cardId) onStart!(b.cardId)
          }
          return (
            <div
              key={i}
              role="button"
              tabIndex={0}
              aria-disabled={!canStart}
              onClick={() => {
                if (moved.current) {
                  moved.current = false
                  return
                }
                start_()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  start_()
                }
              }}
              onPointerDown={(e) => {
                if (e.button !== 0 || e.pointerType === 'touch') return
                e.currentTarget.setPointerCapture(e.pointerId)
                moved.current = false
                setMoving({ index: i, y0: e.clientY, shift: 0 })
              }}
              onPointerMove={(e) => {
                if (moving?.index !== i) return
                const dy = e.clientY - moving.y0
                if (Math.abs(dy) > 4) moved.current = true
                const s = shiftOf(dy)
                if (s !== moving.shift) setMoving({ ...moving, shift: s })
              }}
              onPointerUp={() => {
                if (moving?.index !== i) return
                setMoving(null)
                if (moved.current && moving.shift) onMoveBlock(i, toMinutes(b.start) + moving.shift)
              }}
              onPointerCancel={() => setMoving(null)}
              title={`${formatClock(b.start)}–${formatClock(b.end)} · ${card?.title ?? 'Task'} · drag to move${onStart ? ', click to start the timer' : ''}`}
              className={`group absolute ${inWork(b) ? 'left-[4.75rem] right-2' : 'left-14 right-1'} cursor-grab select-none overflow-hidden border-l-[3px] px-2 py-0.5 text-left transition hover:brightness-95 ${past || finished ? 'opacity-50' : ''} ${live || activeCardId === b.cardId ? 'ring-1 ring-fg/40' : ''} ${shift ? 'z-20 cursor-grabbing shadow-lg' : quick ? 'z-[5]' : ''}`}
              style={{ top, height: shown, borderLeftColor: color, backgroundColor: `${color}26`, transition: moving?.index === i ? 'none' : undefined }}
            >
              <span className="flex items-center gap-1.5 truncate pr-12 text-[11px] leading-tight text-fg">
                <span className="font-mono text-[10px] text-fg-subtle">{formatClock(fromMinutes(start))}</span>
                {card?.key && <span className="font-mono text-[10px]" style={{ color }}>{card.key}</span>}
                <span className={`truncate ${card?.column === 'done' ? 'line-through opacity-60' : ''}`}>{card?.title ?? 'Task'}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-subtle">{finished ? '✓' : quick ? '' : '🍅'}{quick && !finished ? '' : n}</span>
              </span>
              {b.cardId && card?.column !== 'done' && (
                <button
                  type="button"
                  aria-pressed={quick}
                  className={`absolute right-5 top-0.5 border px-1 font-mono text-[9px] leading-[12px] transition ${
                    quick
                      ? 'border-amber-500/60 bg-amber-100 text-amber-800'
                      : 'border-line text-fg-subtle opacity-60 hover:text-fg-muted hover:opacity-100'
                  }`}
                  aria-label={quick ? 'Make this a full pomodoro again' : 'Make this a 5-minute task'}
                  title={quick ? `5-minute task · click to go back to a ${plan.focusMinutes}-minute pomodoro` : `Make this a 5-minute task instead of a ${plan.focusMinutes}-minute pomodoro`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleQuick(i)
                  }}
                >
                  5m
                </button>
              )}
              <button
                type="button"
                className="absolute right-0.5 top-0.5 hidden p-0.5 text-fg-subtle hover:text-fg group-hover:block group-focus-within:block"
                aria-label="Remove this time block"
                title="Remove this time block"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemoveBlock(i)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        {ghost && (
          <div
            className="pointer-events-none absolute left-14 right-1 z-20 border border-dashed px-2 py-0.5 font-mono text-[10px]"
            style={{
              top: PAD + (ghost.start - lo) * PX_PER_MIN,
              height: Math.max(4, ghost.length * PX_PER_MIN - 2),
              borderColor: ghost.tag ? workTag(ghost.tag).accent : '#0284C7cc',
              backgroundColor: ghost.tag ? `${workTag(ghost.tag).accent}22` : '#0284C726',
              color: ghost.tag ? workTag(ghost.tag).accent : '#0284C7',
            }}
          >
            {ghost.tag && `${workTag(ghost.tag).name} · `}
            {formatClock(fromMinutes(ghost.start))}–{formatClock(fromMinutes(ghost.start + ghost.length))}
          </div>
        )}
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
        {timer.quick ? '5-minute task' : MODE_LABELS[timer.mode]}
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
