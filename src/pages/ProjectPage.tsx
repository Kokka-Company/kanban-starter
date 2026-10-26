import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CornerLeftUp, Github, Pencil, X } from 'lucide-react'
import { api, errorMessage, isOverdue, type Workspace, type Card, type Column, type Person, type Project } from '../lib/api'
import { useMe } from '../lib/me'
import { useLabels } from '../lib/labels'
import { useAutoRefresh } from '../lib/useAutoRefresh'
import Board from '../components/Board'
import CardDrawer from '../components/CardDrawer'
import { ErrorNote, PageHeader, Spinner } from '../components/ui'
import WorkspaceMark from '../components/WorkspaceMark'
import { LabelChips, LabelPicker, PersonFilter } from '../components/pickers'
import { matchesPeople } from '../lib/filters'
import { ProjectDueBadge, ProjectDueField } from '../components/ProjectDue'

type ParentCard = { id: string; projectId: string; title: string; key: string | null }

/** `/p/:projectId` — the kanban board. `?card=<id>` opens a card in the side drawer. */
export default function ProjectPage() {
  const { projectId = '' } = useParams()
  const { me } = useMe()
  const { labels } = useLabels()
  const [params, setParams] = useSearchParams()
  const openCardId = params.get('card')

  const [project, setProject] = useState<Project | null>(null)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [parentCard, setParentCard] = useState<ParentCard | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)

  const [who, setWho] = useState('') // dropdown: '' anyone, 'me', 'none', or an email
  const [circles, setCircles] = useState<string[]>([]) // #8 avatar filter, several at once
  const [labelId, setLabelId] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [delayedOnly, setDelayedOnly] = useState(false)
  const [text, setText] = useState('')

  const load = useCallback(
    async (background = false) => {
      try {
        const r = await api.board(projectId)
        setProject(r.project)
        setWorkspace(r.workspace)
        setParentCard(r.parentCard)
        setCards(r.cards)
        setPeople(r.members)
        setError('')
      } catch (err) {
        if (!background) setError(errorMessage(err, 'Could not load the board.'))
      }
    },
    [projectId],
  )

  useEffect(() => {
    void load()
  }, [load])
  // Other people's moves and new cards appear within 15s, or as soon as you return to the tab.
  useAutoRefresh(() => load(true))

  const visible = useMemo(() => {
    const needle = text.trim().toLowerCase()
    return cards.filter((c) => {
      if (who === 'me' && !c.assigneeEmails.includes(me.email)) return false
      if (who === 'none' && c.assigneeEmails.length) return false
      if (who && who !== 'me' && who !== 'none' && !c.assigneeEmails.includes(who)) return false
      if (!matchesPeople(c.assigneeEmails, circles)) return false
      if (labelId && !c.labelIds.includes(labelId)) return false
      if (overdueOnly && !isOverdue(c)) return false
      if (delayedOnly && !c.delayed) return false
      if (needle && !`${c.key ?? ''}\n${c.title}\n${c.description}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [cards, who, circles, labelId, overdueOnly, delayedOnly, text, me.email])

  const replaceCard = (card: Card) => setCards((prev) => prev.map((c) => (c.id === card.id ? card : c)))

  const move = async (id: string, column: Column, order: number) => {
    const before = cards
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, column, order } : c)))
    try {
      replaceCard((await api.updateCard(id, { column, order })).card)
    } catch (err) {
      setCards(before)
      setError(errorMessage(err, 'Could not move the card.'))
    }
  }

  const create = async (column: Column, title: string) => {
    try {
      const { card } = await api.createCard(projectId, { title, column })
      setCards((prev) => [...prev, card])
    } catch (err) {
      setError(errorMessage(err, 'Could not add the card.'))
    }
  }

  const filtered = Boolean(who || circles.length || labelId || overdueOnly || delayedOnly || text.trim())
  const clearFilters = () => {
    setWho('')
    setCircles([])
    setLabelId('')
    setOverdueOnly(false)
    setDelayedOnly(false)
    setText('')
  }

  if (error && !project) return <ErrorNote message={error} />
  if (!project || !workspace) return <Spinner />

  return (
    <>
      {/* #6: straight back to the workspace's project list. */}
      <Link to={`/w/${workspace.id}`} className="btn-ghost -ml-3 mb-2 px-3 py-1.5">
        <ArrowLeft className="h-4 w-4" /> {workspace.name}
      </Link>
      <PageHeader
        title={project.name}
        mark={<WorkspaceMark id={workspace.id} name={workspace.name} size={40} />}
        crumbs={
          <>
            <Link to="/" className="hover:text-accent">Workspaces</Link>
            {' / '}
            <Link to={`/w/${workspace.id}`} className="hover:text-accent">{workspace.name}</Link>
          </>
        }
        actions={
          <>
            {project.repoUrl && (
              <a href={project.repoUrl} target="_blank" rel="noreferrer" className="btn-ghost border border-line-strong">
                <Github className="h-4 w-4" /> Source
              </a>
            )}
            {me.canEdit && (
              <button className="btn-ghost border border-line-strong" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" /> Edit project
              </button>
            )}
          </>
        }
      />
      <div className="-mt-3 mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        {!me.canEdit && (
          <span className="border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[11px] uppercase tracking-widest text-amber-800">
            View only
          </span>
        )}
        <ProjectDueBadge dueDate={project.dueDate} ongoing={project.ongoing} />
        <LabelChips ids={project.labelIds} />
        {parentCard && (
          <Link
            to={`/p/${parentCard.projectId}?card=${parentCard.id}`}
            className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-fg-subtle hover:text-accent"
          >
            <CornerLeftUp className="h-3.5 w-3.5" /> From task {parentCard.key ?? parentCard.title}
          </Link>
        )}
      </div>
      {project.description && <p className="-mt-2 mb-5 max-w-3xl text-sm text-fg-muted">{project.description}</p>}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input w-56" placeholder="Filter this board…" value={text} onChange={(e) => setText(e.target.value)} />
        <select className="input w-44" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Assignee">
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {people.map((p) => (
            <option key={p.email} value={p.email}>{p.name}</option>
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
        {filtered && (
          <button className="btn-ghost" onClick={clearFilters}>
            <X className="h-4 w-4" /> Clear
          </button>
        )}
      </div>
      <div className="mb-4">
        <PersonFilter people={people} value={circles} onChange={setCircles} />
      </div>

      {error && <div className="mb-3"><ErrorNote message={error} /></div>}

      <Board
        cards={visible}
        people={people}
        onOpen={(id) => setParams({ card: id })}
        onMove={(id, column, order) => void move(id, column, order)}
        onCreate={create}
        canEdit={me.canEdit}
      />

      {openCardId && (
        <CardDrawer
          key={openCardId}
          cardId={openCardId}
          people={people}
          onClose={() => setParams({})}
          onChange={replaceCard}
          onDelete={(id) => {
            setCards((prev) => prev.filter((c) => c.id !== id))
            setParams({})
          }}
          onDuplicated={(copy) => {
            void load(true)
            setParams({ card: copy.id })
          }}
        />
      )}

      {editing && (
        <EditProject
          project={project}
          onClose={() => setEditing(false)}
          onSaved={(p) => {
            setProject(p)
            setEditing(false)
          }}
        />
      )}
    </>
  )
}

function EditProject({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const navigate = useNavigate()
  const { me } = useMe()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [repoUrl, setRepoUrl] = useState(project.repoUrl)
  const [due, setDue] = useState({ dueDate: project.dueDate, ongoing: project.ongoing })
  const [labelIds, setLabelIds] = useState(project.labelIds)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => onSaved((await api.updateProject(project.id, { name, description, repoUrl, ...due, labelIds })).project))
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/20 px-4 py-16" onClick={onClose}>
      <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="glass-solid w-full max-w-lg space-y-3 p-6 shadow-2xl">
        <h2 className="font-display text-xl text-fg">Edit project</h2>
        <div>
          <label className="label" htmlFor="ep-name">Name</label>
          <input id="ep-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <ProjectDueField idPrefix="ep" dueDate={due.dueDate} ongoing={due.ongoing} onChange={setDue} />
        <div>
          <span className="label">Labels</span>
          <LabelPicker value={labelIds} onChange={setLabelIds} />
        </div>
        <div>
          <label className="label" htmlFor="ep-repo">GitHub / source link</label>
          <input id="ep-repo" className="input" type="url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="ep-desc">Description</label>
          <textarea id="ep-desc" className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <ErrorNote message={error} />
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <button className="btn-primary" disabled={busy}>Save</button>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <span className="flex-1" />
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => void run(async () => onSaved((await api.updateProject(project.id, { archived: !project.archived })).project))}
          >
            {project.archived ? 'Unarchive' : 'Archive'}
          </button>
          {me.isAdmin && (
            <button
              type="button"
              className="btn-danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Delete "${project.name}" and all its cards and comments? This can't be undone.`)) return
                void run(async () => {
                  await api.deleteProject(project.id)
                  navigate(`/w/${project.workspaceId}`)
                })
              }}
            >
              Delete
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
