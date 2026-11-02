import { addDays, isOverdue, todayISO, type Card, type DayBlock, type DayPlan, type DayPlanItem } from './api'

/** "09:30" → 570 */
export function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** 570 → "09:30" (clamped to the day). */
export function fromMinutes(min: number) {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** "13:05" → "1:05 pm" in the viewer's locale style. */
export function formatClock(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function nowMinutes() {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

/** Your share of a task's planned hours (split across its assignees), or null if it has no estimate. */
export function myHours(card: Card) {
  return card.plannedHours ? card.plannedHours / Math.max(1, card.assigneeEmails.length) : null
}

/** Pomodoros a task gets by default: its planned hours in focus sessions (1–8), or 2 when there's no estimate. */
export function suggestedPomodoros(card: Card, focusMinutes: number) {
  const h = myHours(card)
  if (!h) return 2
  return Math.min(8, Math.max(1, Math.ceil((h * 60) / focusMinutes)))
}

/**
 * Lower is more urgent: overdue, due today, already in progress, in review, due in
 * the next 3 days, to do, everything else. Ties go to the earlier due date.
 */
export function urgency(card: Card, today = todayISO()) {
  if (isOverdue(card)) return 0
  if (card.dueDate === today) return 1
  if (card.column === 'doing') return 2
  if (card.column === 'review') return 3
  if (card.dueDate && card.dueDate <= addDays(today, 3)) return 4
  if (card.column === 'todo') return 5
  return 6
}

export function byUrgency(a: Card, b: Card) {
  return urgency(a) - urgency(b) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || (a.key || '').localeCompare(b.key || '', undefined, { numeric: true })
}

/** Where the schedule starts: the plan's start time, or now (rounded up to 5 min) if that's later and the plan is for today. */
export function scheduleStart(plan: Pick<DayPlan, 'date' | 'startTime'>) {
  const start = toMinutes(plan.startTime)
  if (plan.date !== todayISO()) return start
  return Math.max(start, Math.ceil(nowMinutes() / 5) * 5)
}

/** How many focus sessions fit between `from` and the end of the day. */
export function capacity(plan: DayPlan, from: number) {
  let t = from
  let n = 0
  const end = toMinutes(plan.endTime)
  while (t + plan.focusMinutes <= end) {
    n++
    t += plan.focusMinutes + (n % plan.longBreakEvery === 0 ? plan.longBreakMinutes : plan.breakMinutes)
  }
  return n
}

/**
 * Lay the remaining pomodoros out in priority order: focus, short break, focus, …,
 * with a long break after every `longBreakEvery` focus sessions. Focus sessions skip
 * over set-aside blocks (e.g. a personal break). Stops at the end of the day; `left`
 * is how many pomodoros didn't fit.
 */
export function schedule(plan: DayPlan, items: DayPlanItem[], from: number, setAside: DayBlock[] = []): { blocks: DayBlock[]; left: number } {
  const end = toMinutes(plan.endTime)
  const blocks: DayBlock[] = []
  const busy = setAside.map((b) => [toMinutes(b.start), toMinutes(b.end)] as const)
  let t = from
  let count = 0
  let left = 0
  for (const item of items) {
    for (let i = 0; i < Math.max(0, item.pomodoros - item.done); i++) {
      for (let hit = busy.find(([s, e]) => s < t + plan.focusMinutes && t < e); hit; hit = busy.find(([s, e]) => s < t + plan.focusMinutes && t < e)) t = hit[1]
      if (t + plan.focusMinutes > end) {
        left++
        continue
      }
      blocks.push({ kind: 'focus', cardId: item.cardId, start: fromMinutes(t), end: fromMinutes(t + plan.focusMinutes) })
      t += plan.focusMinutes
      count++
      const long = count % plan.longBreakEvery === 0
      const rest = long ? plan.longBreakMinutes : plan.breakMinutes
      // A break that runs into set-aside time stops where it starts.
      const cut = Math.min(t + rest, ...busy.filter(([s]) => s >= t).map(([s]) => s))
      if (cut > t) blocks.push({ kind: long ? 'long' : 'break', cardId: null, start: fromMinutes(t), end: fromMinutes(Math.min(cut, 23 * 60 + 59)) })
      t += rest
    }
  }
  // No point ending the day on a break.
  while (blocks.length && blocks[blocks.length - 1].kind !== 'focus') blocks.pop()
  return { blocks, left }
}

/**
 * The automatic plan: keep whatever tasks you already picked (in your order); if you
 * haven't picked any, fill the day with your most urgent open tasks. Then lay them out.
 */
export function autoPlan(plan: DayPlan, openCards: Card[]) {
  const from = scheduleStart(plan)
  let items = plan.items
  if (!items.length) {
    // Past the end of the day already? Still pick a full day's worth, so you have your priorities.
    const room = capacity(plan, from) || capacity(plan, toMinutes(plan.startTime))
    let used = 0
    items = []
    for (const card of [...openCards].sort(byUrgency)) {
      if (used >= room) break
      const pomodoros = Math.min(suggestedPomodoros(card, plan.focusMinutes), room - used)
      items.push({ cardId: card.id, pomodoros, done: 0 })
      used += pomodoros
    }
  }
  const { blocks, left } = schedule(plan, items, from, plan.blocks.filter((b) => b.kind === 'work'))
  return { items, blocks, left }
}

const LAST_MINUTE = 23 * 60 + 59

/** The hours the schedule shows: the working day, widened to fit every block, on whole hours. */
export function timelineRange(plan: Pick<DayPlan, 'startTime' | 'endTime' | 'blocks'>) {
  const starts = [toMinutes(plan.startTime), ...plan.blocks.map((b) => toMinutes(b.start))]
  const ends = [toMinutes(plan.endTime), ...plan.blocks.map((b) => toMinutes(b.end))]
  return { lo: Math.floor(Math.min(...starts) / 60) * 60, hi: Math.min(24 * 60, Math.ceil(Math.max(...ends) / 60) * 60) }
}

export const byStart = (a: DayBlock, b: DayBlock) => toMinutes(a.start) - toMinutes(b.start)

/** A set-aside block (e.g. a personal break), clamped to the day, in time order with the rest. */
export function placeWork(blocks: DayBlock[], tag: string, start: number, length: number): DayBlock[] {
  const s = Math.max(0, Math.min(Math.round(start), LAST_MINUTE - length))
  return [...blocks, { kind: 'work' as const, cardId: null, tag, start: fromMinutes(s), end: fromMinutes(s + length) }].sort(byStart)
}

/**
 * Book a focus block for `cardId` at `start` (minutes), `length` long. If that lands on
 * another focus block or a set-aside block (e.g. a personal break) it slides to just
 * after it, so they never overlap; pomodoro breaks it covers are dropped. Returns the
 * new blocks in time order, or null if it won't fit before midnight.
 */
export function placeFocus(blocks: DayBlock[], cardId: string, start: number, length: number): DayBlock[] | null {
  const focus = blocks.filter((b) => b.kind === 'focus' || b.kind === 'work')
  let s = Math.max(0, Math.round(start))
  for (let guard = 0; guard < 200; guard++) {
    const hit = focus.find((b) => toMinutes(b.start) < s + length && s < toMinutes(b.end))
    if (!hit) break
    s = toMinutes(hit.end)
  }
  if (s + length > LAST_MINUTE) return null
  const covers = (b: DayBlock) => toMinutes(b.start) < s + length && s < toMinutes(b.end)
  const block: DayBlock = { kind: 'focus', cardId, start: fromMinutes(s), end: fromMinutes(s + length) }
  return [...blocks.filter((b) => (b.kind !== 'break' && b.kind !== 'long') || !covers(b)), block].sort(byStart)
}

/** Pomodoros your share of the task's planned time comes to (no 1–8 cap), or null with no estimate. */
export function pomodorosFor(card: Card, focusMinutes: number) {
  const h = myHours(card)
  return h ? Math.ceil((h * 60) / focusMinutes) : null
}

/**
 * The estimate (the guess, before the buffer) whose planned time comes to exactly
 * `pomodoros` focus sessions of your share. Estimates go in 0.1 h steps, so this is
 * the largest one that still rounds to that many sessions.
 */
export function estimateFor(pomodoros: number, focusMinutes: number, assignees: number, buffer: number) {
  const n = Math.max(1, assignees)
  const target = (pomodoros * focusMinutes * n) / 60 / buffer
  let best: number | null = null
  for (let e = Math.max(0.1, Math.floor(target * 10) / 10 - 0.5); e <= target + 0.5; e = Math.round((e + 0.1) * 10) / 10) {
    const planned = Math.round(e * buffer * 10) / 10
    if (Math.ceil(((planned / n) * 60) / focusMinutes) === pomodoros) best = e
  }
  return best ?? Math.max(0.1, Math.round(target * 10) / 10)
}

/**
 * Whether changing today's pomodoros for a task should change its estimate. With no
 * estimate, always. Adding: only once you go past what the estimate covers (a big task
 * spread over several days keeps its estimate). Removing: only if today's plan held the
 * whole estimate.
 */
export function estimateFollows(card: Card, focusMinutes: number, from: number, to: number) {
  const full = pomodorosFor(card, focusMinutes)
  if (full === null) return true
  return to > from ? to > full : from === full
}
