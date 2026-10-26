import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ChevronDown, History as HistoryIcon, Trash2, X } from 'lucide-react'
import {
  api,
  COLUMNS,
  COLUMN_LABELS,
  errorMessage,
  isOverdue,
  timeAgo,
  type Card,
  type ChecklistItem,
  type Column,
  type Comment,
  type Person,
  type ActivityEntry,
} from '../lib/api'
import { useMe } from '../lib/me'
import { Avatar, ErrorNote, Spinner } from './ui'
import ActivityRow from './ActivityRow'

type Patch = Parameters<typeof api.updateCard>[1]

/**
 * The card side panel. Every field saves on its own (on change or on blur), so there
 * is no Save button to forget.
 */
export default function CardDrawer({
  cardId,
  people,
  onClose,
  onChange,
  onDelete,
}: {
  cardId: string
  people: Person[]
  onClose: () => void
  onChange: (card: Card) => void
  onDelete: (id: string) => void
}) {
  const { me } = useMe()
  const [card, setCard] = useState<Card | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    api
      .card(cardId)
      .then((r) => {
        setCard(r.card)
        setTitle(r.card.title)
        setDescription(r.card.description)
        setComments(r.comments)
      })
      .catch((err) => setError(errorMessage(err, 'Could not load the card.')))
  }, [cardId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (patch: Patch) => {
    if (!card) return
    const previous = card
    setCard({ ...card, ...patch } as Card)
    setError('')
    try {
      const { card: saved } = await api.updateCard(card.id, patch)
      setCard(saved)
      onChange(saved)
    } catch (err) {
      setCard(previous)
      setError(errorMessage(err, 'Could not save.'))
    }
  }

  const remove = async () => {
    if (!card || !window.confirm('Delete this card and its comments?')) return
    try {
      await api.deleteCard(card.id)
      onDelete(card.id)
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the card.'))
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <aside
        className="glass-solid flex h-full w-full max-w-xl flex-col overflow-y-auto border-y-0 border-r-0"
        onClick={(e) => e.stopPropagation()}
        aria-label="Card details"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-xs uppercase tracking-wide text-fg-subtle">Card</span>
          <div className="flex items-center gap-1">
            {card && me.canEdit && (
              <button className="btn-danger p-2" onClick={() => void remove()} title="Delete card">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <button className="btn-ghost p-2" onClick={onClose} title="Close (Esc)">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {!card ? (
          <div className="p-5">{error ? <ErrorNote message={error} /> : <Spinner />}</div>
        ) : (
          <div className="space-y-6 p-5">
            {/* A disabled fieldset makes every field inside read-only for viewers in one go. */}
            <fieldset disabled={!me.canEdit} className="space-y-6 disabled:opacity-90">
            <textarea
              className="w-full resize-none border-0 bg-transparent p-0 font-display text-2xl font-semibold tracking-tight text-fg focus:outline-none focus:ring-0"
              rows={2}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title.trim() !== card.title && void save({ title: title.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
              aria-label="Title"
            />

            <ErrorNote message={error} />

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="cd-col">Column</label>
                <select id="cd-col" className="input" value={card.column} onChange={(e) => void save({ column: e.target.value as Column })}>
                  {COLUMNS.map((c) => (
                    <option key={c} value={c}>{COLUMN_LABELS[c]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="cd-who">Assignee</label>
                <select
                  id="cd-who"
                  className="input"
                  value={card.assigneeEmail || ''}
                  onChange={(e) => void save({ assigneeEmail: e.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {people.map((p) => (
                    <option key={p.email} value={p.email}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="cd-due">Due date</label>
                <input
                  id="cd-due"
                  type="date"
                  className={`input ${isOverdue(card) ? 'border-red-400 text-red-700' : ''}`}
                  value={card.dueDate || ''}
                  onChange={(e) => void save({ dueDate: e.target.value || null })}
                />
              </div>
            </div>

            <div>
              <label className="label" htmlFor="cd-desc">Description</label>
              <textarea
                id="cd-desc"
                className="input min-h-28"
                rows={5}
                placeholder="Add more detail…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => description !== card.description && void save({ description })}
              />
            </div>

            <Checklist items={card.checklist} onSave={(checklist) => void save({ checklist })} readOnly={!me.canEdit} />
            </fieldset>

            <Comments
              cardId={card.id}
              comments={comments}
              people={people}
              onAdded={(c) => {
                setComments((prev) => [...prev, c])
                const next = { ...card, commentCount: card.commentCount + 1 }
                setCard(next)
                onChange(next)
              }}
              onDeleted={(id) => {
                setComments((prev) => prev.filter((c) => c.id !== id))
                const next = { ...card, commentCount: Math.max(0, card.commentCount - 1) }
                setCard(next)
                onChange(next)
              }}
            />

            <History cardId={card.id} refreshKey={`${card.updatedBy.at}-${comments.length}`} />

            <p className="border-t border-line pt-4 text-xs text-fg-subtle">
              Created by {card.createdBy.label} {timeAgo(card.createdBy.at)} · Last changed by {card.updatedBy.label} {timeAgo(card.updatedBy.at)}
            </p>
          </div>
        )}
      </aside>
    </div>
  )
}

function Checklist({ items, onSave, readOnly }: { items: ChecklistItem[]; onSave: (items: ChecklistItem[]) => void; readOnly: boolean }) {
  const [draft, setDraft] = useState('')
  const done = items.filter((i) => i.done).length

  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    onSave([...items, { id: crypto.randomUUID(), text: draft.trim(), done: false }])
    setDraft('')
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="label mb-0">Checklist</span>
        {items.length > 0 && <span className="text-xs text-fg-subtle">{done}/{items.length}</span>}
      </div>
      {items.length > 0 && (
        <div className="mb-2 h-1 bg-muted">
          <div className="h-1 bg-fg-muted transition-all" style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
      )}
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="group flex items-start gap-2 py-0.5">
            <input
              type="checkbox"
              className="mt-1"
              checked={item.done}
              onChange={() => onSave(items.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)))}
              aria-label={item.text}
            />
            <span className={`flex-1 text-sm ${item.done ? 'text-fg-subtle line-through' : 'text-fg'}`}>{item.text}</span>
            <button
              className="p-0.5 text-fg-subtle opacity-0 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
              title="Remove item"
              onClick={() => onSave(items.filter((i) => i.id !== item.id))}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {!readOnly && <form onSubmit={add} className="mt-2">
        <input className="input" placeholder="Add an item and press Enter" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </form>}
    </div>
  )
}

/** Comment thread with an @-picker: type "@" and a name to mention someone (they get a Teams ping). */
function Comments({
  cardId,
  comments,
  people,
  onAdded,
  onDeleted,
}: {
  cardId: string
  comments: Comment[]
  people: Person[]
  onAdded: (c: Comment) => void
  onDeleted: (id: string) => void
}) {
  const { me } = useMe()
  const [body, setBody] = useState('')
  const [picked, setPicked] = useState<Person[]>([])
  const [query, setQuery] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const nameOf = useMemo(() => Object.fromEntries(people.map((p) => [p.email, p.name])), [people])

  const suggestions = useMemo(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    return people.filter((p) => p.name.toLowerCase().includes(q) || p.email.includes(q)).slice(0, 6)
  }, [query, people])

  const onInput = (value: string) => {
    setBody(value)
    const caret = box.current?.selectionStart ?? value.length
    const m = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret))
    setQuery(m ? m[1] : null)
  }

  const pick = (p: Person) => {
    const el = box.current
    const caret = el?.selectionStart ?? body.length
    const head = body.slice(0, caret).replace(/@([^\s@]*)$/, `@${p.name} `)
    setBody(head + body.slice(caret))
    setPicked((prev) => (prev.some((x) => x.email === p.email) ? prev : [...prev, p]))
    setQuery(null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(head.length, head.length)
    })
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!body.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      // Only people whose "@Name" is still in the text after editing.
      const mentions = picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.email)
      const { comment } = await api.addComment(cardId, body.trim(), mentions)
      onAdded(comment)
      setBody('')
      setPicked([])
    } catch (err) {
      setError(errorMessage(err, 'Could not post the comment.'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await api.deleteComment(id)
      onDeleted(id)
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the comment.'))
    }
  }

  return (
    <div>
      <span className="label">Comments</span>
      <ul className="mb-3 space-y-4">
        {comments.map((c) => (
          <li key={c.id} className="group flex gap-3">
            <Avatar name={nameOf[c.author.email] || c.author.label} size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="font-medium text-fg">{nameOf[c.author.email] || c.author.label}</span>
                <span className="text-xs text-fg-subtle">{timeAgo(c.createdAt)}</span>
                {(c.author.email === me.email || me.isAdmin) && (
                  <button className="ml-auto text-xs text-fg-subtle opacity-0 hover:text-red-600 group-hover:opacity-100" onClick={() => void remove(c.id)}>
                    Delete
                  </button>
                )}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg-muted">{c.body}</p>
            </div>
          </li>
        ))}
      </ul>

      {me.canEdit && <form onSubmit={submit} className="relative">
        <textarea
          ref={box}
          className="input"
          rows={3}
          placeholder="Write a comment… type @ to mention someone"
          value={body}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (suggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
              e.preventDefault()
              pick(suggestions[0])
            } else if (e.key === 'Escape' && query !== null) {
              e.stopPropagation()
              setQuery(null)
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              void submit()
            }
          }}
        />
        {suggestions.length > 0 && (
          <ul className="absolute left-0 right-0 top-full z-10 mt-1 glass-solid shadow-lg">
            {suggestions.map((p) => (
              <li key={p.email}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(p)
                  }}
                >
                  <Avatar name={p.name} /> {p.name} <span className="text-xs text-fg-subtle">{p.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex items-center gap-3">
          <button className="btn-primary" disabled={busy || !body.trim()}>Comment</button>
          <span className="text-xs text-fg-subtle">⌘/Ctrl + Enter to post</span>
        </div>
        <div className="mt-2"><ErrorNote message={error} /></div>
      </form>}
    </div>
  )
}

/** Everything that happened to this card, from the activity log. Folded away until asked for. */
function History({ cardId, refreshKey }: { cardId: string; refreshKey: string }) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    api
      .cardActivity(cardId)
      .then((r) => setEntries(r.entries))
      .catch((err) => setError(errorMessage(err, 'Could not load the history.')))
  }, [open, cardId, refreshKey])

  return (
    <div>
      <button className="label mb-0 flex items-center gap-1.5 hover:text-accent" onClick={() => setOpen(!open)}>
        <HistoryIcon className="h-3.5 w-3.5" /> History
        <ChevronDown className={`h-3.5 w-3.5 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-2">
          <ErrorNote message={error} />
          {!entries ? (
            !error && <Spinner />
          ) : entries.length === 0 ? (
            <p className="text-sm text-fg-subtle">No recorded changes yet.</p>
          ) : (
            <ul className="divide-y divide-line border border-line">
              {entries.map((e) => (
                <ActivityRow key={e.id} entry={e} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
