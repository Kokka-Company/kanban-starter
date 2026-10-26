import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, CalendarDays, CheckSquare, Clock, Folder, MessageSquare, Plus } from 'lucide-react'
import { COLUMNS, COLUMN_LABELS, formatDue, formatHours, isOverdue, type Card, type Column, type Person } from '../lib/api'
import { AvatarStack, LabelChips } from './pickers'

type Lanes = Record<Column, string[]>

const ORDER_STEP = 1000

/** Status dot for each column header. Placeholder greys, light to dark — swap in colours if you like. */
const COLUMN_COLORS: Record<Column, string> = {
  backlog: '#d4d4d8',
  todo: '#a1a1aa',
  doing: '#71717a',
  review: '#52525b',
  done: '#27272a',
}

function lanesFrom(cards: Card[]): Lanes {
  const lanes = Object.fromEntries(COLUMNS.map((c) => [c, [] as string[]])) as Lanes
  for (const card of [...cards].sort((a, b) => a.order - b.order)) lanes[card.column].push(card.id)
  return lanes
}

function laneOf(lanes: Lanes, id: string): Column | undefined {
  if ((COLUMNS as readonly string[]).includes(id)) return id as Column
  return COLUMNS.find((c) => lanes[c].includes(id))
}

/**
 * Five fixed columns with drag and drop. `cards` is already filtered by the parent.
 * While dragging, the lane layout lives in local state; on drop we work out the
 * card's new neighbours and give it an `order` halfway between them, so only the
 * moved card is saved.
 */
export default function Board({
  cards,
  people,
  onOpen,
  onMove,
  onCreate,
  canEdit,
}: {
  cards: Card[]
  people: Person[]
  /** Viewers get the same board with dragging and adding switched off. */
  canEdit: boolean
  onOpen: (id: string) => void
  onMove: (id: string, column: Column, order: number) => void
  onCreate: (column: Column, title: string) => Promise<void>
}) {
  const byId = useMemo(() => Object.fromEntries(cards.map((c) => [c.id, c])), [cards])
  const settled = useMemo(() => lanesFrom(cards), [cards])
  const [dragLanes, setDragLanes] = useState<Lanes | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const lanes = dragLanes ?? settled

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click still opens the card.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const noSensors = useSensors()

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id))
    setDragLanes(settled)
  }

  // Moving into another column: re-home the card there right away so the lane opens a gap.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !dragLanes) return
    const from = laneOf(dragLanes, String(active.id))
    const to = laneOf(dragLanes, String(over.id))
    if (!from || !to || from === to) return
    setDragLanes((prev) => {
      if (!prev) return prev
      const target = prev[to]
      const overIndex = target.indexOf(String(over.id))
      const index = overIndex === -1 ? target.length : overIndex
      return {
        ...prev,
        [from]: prev[from].filter((id) => id !== active.id),
        [to]: [...target.slice(0, index), String(active.id), ...target.slice(index)],
      }
    })
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const id = String(active.id)
    let final = dragLanes
    setDragLanes(null)
    setActiveId(null)
    if (!final || !over) return

    const col = laneOf(final, id)
    const overCol = laneOf(final, String(over.id))
    if (!col) return
    if (overCol === col && over.id !== id && !(COLUMNS as readonly string[]).includes(String(over.id))) {
      const lane = final[col]
      final = { ...final, [col]: arrayMove(lane, lane.indexOf(id), lane.indexOf(String(over.id))) }
    }

    const lane = final[col]
    const index = lane.indexOf(id)
    const before = byId[lane[index - 1]]
    const after = byId[lane[index + 1]]
    const card = byId[id]
    const sameSpot =
      card.column === col &&
      settled[col][settled[col].indexOf(id) - 1] === before?.id &&
      settled[col][settled[col].indexOf(id) + 1] === after?.id
    if (sameSpot) return

    const order =
      before && after
        ? (before.order + after.order) / 2
        : before
          ? before.order + ORDER_STEP
          : after
            ? after.order - ORDER_STEP
            : ORDER_STEP
    onMove(id, col, order)
  }

  const active = activeId ? byId[activeId] : null

  return (
    <DndContext
      sensors={canEdit ? sensors : noSensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragLanes(null)
        setActiveId(null)
      }}
    >
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-4">
        {COLUMNS.map((col) => (
          <Lane key={col} column={col} count={lanes[col].length} onCreate={canEdit ? onCreate : undefined}>
            <SortableContext items={lanes[col]} strategy={verticalListSortingStrategy}>
              {lanes[col].map((id) =>
                byId[id] ? (
                  <SortableCard key={id} card={byId[id]} people={people} onOpen={onOpen} />
                ) : null,
              )}
            </SortableContext>
          </Lane>
        ))}
      </div>
      <DragOverlay>
        {active ? <CardTile card={active} people={people} dragging /> : null}
      </DragOverlay>
    </DndContext>
  )
}

function Lane({
  column,
  count,
  onCreate,
  children,
}: {
  column: Column
  count: number
  /** Absent for viewers: no add buttons. */
  onCreate?: (column: Column, title: string) => Promise<void>
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column })
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!title.trim() || busy || !onCreate) return
    setBusy(true)
    try {
      await onCreate(column, title.trim())
      setTitle('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="glass relative flex w-72 shrink-0 flex-col sm:w-auto sm:min-w-64 sm:flex-1">
      <span className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, ${COLUMN_COLORS[column]}, transparent)` }} />
      <header className="flex items-center justify-between px-3 py-3">
        <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-fg-muted">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: COLUMN_COLORS[column] }} />
          {COLUMN_LABELS[column]}
          <span className="text-fg-subtle">{String(count).padStart(2, '0')}</span>
        </h2>
        {onCreate && (
          <button className="p-1 text-fg-subtle hover:text-accent" title="Add card" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
          </button>
        )}
      </header>
      <div ref={setNodeRef} className={`flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2 transition-colors ${isOver ? 'bg-accent/5' : ''}`}>
        {children}
        {!onCreate ? null : adding ? (
          <form onSubmit={submit} className="border border-accent/40 bg-surface p-2">
            <textarea
              autoFocus
              rows={2}
              className="input resize-none"
              placeholder="What needs doing?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submit()
                }
                if (e.key === 'Escape') setAdding(false)
              }}
            />
            <div className="mt-2 flex gap-2">
              <button className="btn-primary py-1" disabled={busy || !title.trim()}>Add</button>
              <button type="button" className="btn-ghost py-1" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <button className="px-1 py-1 text-left text-sm text-fg-subtle hover:text-accent" onClick={() => setAdding(true)}>
            + Add card
          </button>
        )}
      </div>
    </section>
  )
}

function SortableCard({ card, people, onOpen }: { card: Card; people: Person[]; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-30' : ''}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => {
        listeners?.onKeyDown?.(e)
        if (e.key === 'Enter') onOpen(card.id)
      }}
    >
      <CardTile card={card} people={people} />
    </div>
  )
}

/** One task on a board or calendar. Delayed tasks (#3) are yellow; overdue dates are red. */
export function CardTile({
  card,
  people,
  dragging = false,
  compact = false,
  showProject = false,
}: {
  card: Card
  people: Person[]
  dragging?: boolean
  compact?: boolean
  /** Name the project the task belongs to — used where tasks from many projects mix (calendar). */
  showProject?: boolean
}) {
  const done = card.checklist.filter((i) => i.done).length
  const overdue = isOverdue(card)
  const tone = card.delayed
    ? 'border-amber-400/60 bg-amber-50 hover:border-amber-500'
    : 'border-line bg-surface hover:border-accent/50 hover:bg-surface hover:shadow-md'
  const hasMeta =
    card.dueDate || card.checklist.length > 0 || card.commentCount > 0 || card.assigneeEmails.length > 0 || card.plannedHours
  return (
    <article className={`cursor-pointer border p-3 text-sm transition duration-200 ${tone} ${dragging ? 'rotate-2 border-accent/60 shadow-md' : ''}`}>
      {(card.key || card.delayed) && (
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
          {card.key && <span>{card.key}</span>}
          {card.delayed && (
            <span className="inline-flex items-center gap-1 text-amber-700" title={card.delayReason}>
              <AlertTriangle className="h-3 w-3" /> Delayed
            </span>
          )}
        </div>
      )}
      {showProject && card.projectName && (
        <Link
          to={`/p/${card.projectId}`}
          onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
          className="mb-1 flex max-w-full items-center gap-1 text-[11px] text-fg-subtle hover:text-accent hover:underline"
          title={`Open project: ${card.projectName}`}
        >
          <Folder className="h-3 w-3 shrink-0" />
          <span className="truncate">{card.projectName}</span>
        </Link>
      )}
      <p className={`whitespace-pre-wrap break-words ${card.column === 'done' ? 'text-fg-subtle line-through' : 'text-fg'}`}>{card.title}</p>
      {!compact && <LabelChips ids={card.labelIds} className="mt-2" />}
      {hasMeta && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap font-mono text-[11px] text-fg-subtle">
          {card.dueDate && (
            <span className={`flex items-center gap-1 ${overdue ? 'font-medium text-red-600' : ''}`} title={overdue ? 'Overdue' : 'Due'}>
              <CalendarDays className="h-3.5 w-3.5" />
              {formatDue(card.dueDate)}
            </span>
          )}
          {card.plannedHours !== null && (
            <span className="flex items-center gap-1" title={`Guess ${formatHours(card.estimateHours)}, planned with buffer ${formatHours(card.plannedHours)}`}>
              <Clock className="h-3.5 w-3.5" />
              {formatHours(card.plannedHours)}
            </span>
          )}
          {!compact && card.checklist.length > 0 && (
            <span className={`flex items-center gap-1 ${done === card.checklist.length ? 'text-emerald-600' : ''}`}>
              <CheckSquare className="h-3.5 w-3.5" />
              {done}/{card.checklist.length}
            </span>
          )}
          {!compact && card.commentCount > 0 && (
            <span className="flex items-center gap-1">
              <MessageSquare className="h-3.5 w-3.5" />
              {card.commentCount}
            </span>
          )}
          {card.assigneeEmails.length > 0 && (
            <span className="ml-auto">
              <AvatarStack emails={card.assigneeEmails} people={people} />
            </span>
          )}
        </div>
      )}
    </article>
  )
}
