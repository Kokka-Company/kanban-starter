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
 * with a long break after every `longBreakEvery` focus sessions. Stops at the end
 * of the day; `left` is how many pomodoros didn't fit.
 */
export function schedule(plan: DayPlan, items: DayPlanItem[], from: number): { blocks: DayBlock[]; left: number } {
  const end = toMinutes(plan.endTime)
  const blocks: DayBlock[] = []
  let t = from
  let count = 0
  let left = 0
  for (const item of items) {
    for (let i = 0; i < Math.max(0, item.pomodoros - item.done); i++) {
      if (t + plan.focusMinutes > end) {
        left++
        continue
      }
      blocks.push({ kind: 'focus', cardId: item.cardId, start: fromMinutes(t), end: fromMinutes(t + plan.focusMinutes) })
      t += plan.focusMinutes
      count++
      const long = count % plan.longBreakEvery === 0
      const rest = long ? plan.longBreakMinutes : plan.breakMinutes
      blocks.push({ kind: long ? 'long' : 'break', cardId: null, start: fromMinutes(t), end: fromMinutes(Math.min(t + rest, 23 * 60 + 59)) })
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
  const { blocks, left } = schedule(plan, items, from)
  return { items, blocks, left }
}
