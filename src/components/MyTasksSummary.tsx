import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ListTodo } from 'lucide-react'
import { api, formatHours, isOverdue, type Card } from '../lib/api'
import { useMe } from '../lib/me'

/** Home-page strip: how much is on your plate, with a way into the My tasks board. */
export default function MyTasksSummary() {
  const { me } = useMe()
  const [cards, setCards] = useState<Card[] | null>(null)

  useEffect(() => {
    api
      .cards({ assignee: me.email })
      .then((r) => setCards(r.cards.filter((c) => c.column !== 'done')))
      .catch(() => setCards([]))
  }, [me.email])

  if (!cards) return null
  const overdue = cards.filter(isOverdue).length
  const delayed = cards.filter((c) => c.delayed).length
  const hours = cards.reduce((s, c) => s + (c.plannedHours ? c.plannedHours / Math.max(1, c.assigneeEmails.length) : 0), 0)

  return (
    <Link to="/tasks" className="glass group mb-8 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 transition hover:border-accent/50">
      <span className="flex items-center gap-2 font-medium text-fg">
        <ListTodo className="h-5 w-5 text-accent" /> My tasks
      </span>
      <span className="font-mono text-xs text-fg-muted">
        <span className="text-fg">{cards.length}</span> open
      </span>
      {overdue > 0 && <span className="font-mono text-xs text-red-600">{overdue} overdue</span>}
      {delayed > 0 && <span className="font-mono text-xs text-amber-700">{delayed} delayed</span>}
      {hours > 0 && <span className="font-mono text-xs text-fg-subtle">{formatHours(Math.round(hours * 10) / 10)} planned</span>}
      <span className="ml-auto flex items-center gap-1 text-sm text-fg-subtle group-hover:text-brand-light">
        Open board <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
      </span>
    </Link>
  )
}
