import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Github, Pencil, X } from 'lucide-react'
import { api, errorMessage, isOverdue, type Workspace, type Card, type Column, type Person, type Project } from '../lib/api'
import { useMe } from '../lib/me'
import { useAutoRefresh } from '../lib/useAutoRefresh'
import Board from '../components/Board'
import CardDrawer from '../components/CardDrawer'
import { ErrorNote, PageHeader, Spinner } from '../components/ui'
import WorkspaceMark from '../components/WorkspaceMark'

/** `/p/:projectId` — the kanban board. `?card=<id>` opens a card in the side drawer. */
export default function ProjectPage() {
  const { projectId = '' } = useParams()
  const { me } = useMe()
  const [params, setParams] = useSearchParams()
  const openCardId = params.get('card')

  const [project, setProject] = useState<Project | null>(null)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)

  const [who, setWho] = useState('') // '' anyone, 'me', 'none', or an email
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [text, setText] = useState('')

  const load = useCallback(
    async (background = false) => {
      try {
        const r = await api.board(projectId)
        setProject(r.project)
        setWorkspace(r.workspace)
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
      if (who === 'me' && c.assigneeEmail !== me.email) return false
      if (who === 'none' && c.assigneeEmail) return false
      if (who && who !== 'me' && who !== 'none' && c.assigneeEmail !== who) return false
      if (overdueOnly && !isOverdue(c)) return false
      if (needle && !`${c.title}\n${c.description}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [cards, who, overdueOnly, text, me.email])

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

  const filtered = Boolean(who || overdueOnly || text.trim())

  if (error && !project) return <ErrorNote message={error} />
  if (!project || !workspace) return <Spinner />

  return (
    <>
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
            {me.isAdmin && (
              <button className="btn-ghost border border-line-strong" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" /> Edit project
              </button>
            )}
          </>
        }
      />
      {!me.canEdit && (
        <p className="mb-4 inline-block border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-amber-800">
          View only
        </p>
      )}
      {project.description && <p className="-mt-4 mb-5 max-w-3xl text-sm text-fg-muted">{project.description}</p>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className="input w-56" placeholder="Filter this board…" value={text} onChange={(e) => setText(e.target.value)} />
        <select className="input w-48" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Assignee">
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {people.map((p) => (
            <option key={p.email} value={p.email}>{p.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 px-2 text-sm text-fg-muted">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          Overdue only
        </label>
        {filtered && (
          <button
            className="btn-ghost"
            onClick={() => {
              setWho('')
              setOverdueOnly(false)
              setText('')
            }}
          >
            <X className="h-4 w-4" /> Clear
          </button>
        )}
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
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [repoUrl, setRepoUrl] = useState(project.repoUrl)
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
    void run(async () => onSaved((await api.updateProject(project.id, { name, description, repoUrl })).project))
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/20 px-4 pt-24" onClick={onClose}>
      <form onSubmit={save} onClick={(e) => e.stopPropagation()} className="glass-solid w-full max-w-lg space-y-3 p-6 shadow-2xl">
        <h2 className="font-display text-xl text-fg">Edit project</h2>
        <div>
          <label className="label" htmlFor="ep-name">Name</label>
          <input id="ep-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
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
        </div>
      </form>
    </div>
  )
}
