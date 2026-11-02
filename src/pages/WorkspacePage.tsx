import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, Github, Plus } from 'lucide-react'
import { api, errorMessage, type Workspace, type Project } from '../lib/api'
import { useMe } from '../lib/me'
import { useAutoRefresh } from '../lib/useAutoRefresh'
import { ErrorNote, PageHeader, Spinner } from '../components/ui'
import WorkspaceMark from '../components/WorkspaceMark'
import { LabelChips, LabelPicker } from '../components/pickers'
import { ProjectDueBadge, ProjectDueField } from '../components/ProjectDue'

const COMPLETED_KEY = 'kanban.workspace.completedOpen'

function readCompletedOpen() {
  try {
    return localStorage.getItem(COMPLETED_KEY) === '1'
  } catch {
    return false
  }
}

/** `/w/:workspaceId` — the workspace's projects. Anyone who can edit (members included) can create them. */
export default function WorkspacePage() {
  const { workspaceId = '' } = useParams()
  const { me } = useMe()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [completedOpen, setCompletedOpen] = useState(readCompletedOpen)
  const [error, setError] = useState('')

  const load = useCallback(
    async (background = false) => {
      try {
        const r = await api.projects(workspaceId, showArchived)
        setWorkspace(r.workspace)
        setProjects(r.projects)
        setError('')
      } catch (err) {
        // A failed background refresh keeps what's on screen rather than flashing an error.
        if (!background) setError(errorMessage(err, 'Could not load projects.'))
      }
    },
    [workspaceId, showArchived],
  )

  useEffect(() => {
    void load()
  }, [load])
  useAutoRefresh(() => load(true))

  if (error && !workspace) return <ErrorNote message={error} />
  if (!workspace || !projects) return <Spinner />

  // Finished projects get their own section at the bottom, out of the way of live work.
  const active = projects.filter((p) => !p.completed)
  const completed = projects
    .filter((p) => p.completed)
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
  const toggleCompleted = () => {
    const v = !completedOpen
    setCompletedOpen(v)
    try {
      localStorage.setItem(COMPLETED_KEY, v ? '1' : '0')
    } catch {
      // ignore
    }
  }

  return (
    <>
      {/* #6: back to all workspaces. */}
      <Link to="/" className="btn-ghost -ml-3 mb-2 px-3 py-1.5">
        <ArrowLeft className="h-4 w-4" /> Workspaces
      </Link>
      <PageHeader
        title={workspace.name}
        mark={<WorkspaceMark id={workspace.id} name={workspace.name} size={48} />}
        crumbs={<Link to="/" className="hover:text-accent">Workspaces</Link>}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived
            </label>
            {me.canEdit && !creating && (
              <button className="btn-primary" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New project
              </button>
            )}
          </>
        }
      />

      {creating && (
        <NewProjectForm
          workspaceId={workspace.id}
          onDone={() => {
            setCreating(false)
            void load()
          }}
        />
      )}

      {projects.length === 0 ? (
        <p className="text-fg-subtle">
          No projects yet.{me.canEdit ? ' Create the first one.' : ''}
        </p>
      ) : active.length === 0 ? (
        <p className="text-fg-subtle">No active projects. Finished ones are under Completed below.</p>
      ) : (
        <ul className="divide-y divide-line glass">
          {active.map((p) => (
            <ProjectRow key={p.id} p={p} />
          ))}
        </ul>
      )}

      {completed.length > 0 && (
        <section className="mt-8" aria-label="Completed projects">
          <button
            className="flex w-full items-center gap-2 border-b border-line pb-2 text-left"
            onClick={toggleCompleted}
            aria-expanded={completedOpen}
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-700" />
            <span className="font-display font-semibold text-fg">Completed</span>
            <span className="font-mono text-xs text-fg-subtle">{completed.length}</span>
            {completedOpen ? <ChevronUp className="ml-auto h-4 w-4 text-fg-subtle" /> : <ChevronDown className="ml-auto h-4 w-4 text-fg-subtle" />}
          </button>
          {completedOpen && (
            <ul className="mt-3 divide-y divide-line glass">
              {completed.map((p) => (
                <ProjectRow key={p.id} p={p} />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  )
}

function ProjectRow({ p }: { p: Project }) {
  return (
    <li className="flex items-center gap-4 px-5 py-4 hover:bg-muted">
      <Link to={`/p/${p.id}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fg">{p.name}</span>
          {p.archived && <span className="bg-muted px-1.5 text-xs text-fg-muted">Archived</span>}
          {p.completed && (
            <span className="bg-emerald-100 px-1.5 text-xs text-emerald-800">
              Completed
              {p.completedAt && ` ${new Date(p.completedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`}
            </span>
          )}
        </div>
        {p.description && <p className="mt-0.5 truncate text-sm text-fg-subtle">{p.description}</p>}
        {(p.dueDate || p.ongoing || p.labelIds.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <ProjectDueBadge dueDate={p.dueDate} ongoing={p.ongoing} />
            <LabelChips ids={p.labelIds} />
          </div>
        )}
      </Link>
      <span className="shrink-0 text-sm text-fg-subtle">
        <span className="font-mono text-xs"><span className="text-accent">{p.openCount ?? 0}</span> open · {p.cardCount ?? 0} total</span>
      </span>
      {p.repoUrl && (
        <a href={p.repoUrl} target="_blank" rel="noreferrer" className="shrink-0 p-1 text-fg-subtle hover:text-accent" title="Source code">
          <Github className="h-4 w-4" />
        </a>
      )}
    </li>
  )
}

function NewProjectForm({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [due, setDue] = useState<{ dueDate: string | null; ongoing: boolean }>({ dueDate: null, ongoing: false })
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.createProject(workspaceId, { name, description, repoUrl, ...due, labelIds })
      onDone()
    } catch (err) {
      setError(errorMessage(err, 'Could not create the project.'))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mb-6 grid gap-3 glass p-5 sm:grid-cols-2">
      <div>
        <label className="label" htmlFor="np-name">Name</label>
        <input id="np-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="np-repo">GitHub / source link</label>
        <input id="np-repo" className="input" type="url" placeholder="https://github.com/…" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
      </div>
      <ProjectDueField idPrefix="np" dueDate={due.dueDate} ongoing={due.ongoing} onChange={setDue} />
      <div>
        <span className="label">Labels</span>
        <LabelPicker value={labelIds} onChange={setLabelIds} />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="np-desc">Description</label>
        <textarea id="np-desc" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="flex items-center gap-2 sm:col-span-2">
        <button className="btn-primary" disabled={busy || !name.trim()}>Create project</button>
        <button type="button" className="btn-ghost" onClick={onDone}>Cancel</button>
      </div>
      <div className="sm:col-span-2"><ErrorNote message={error} /></div>
    </form>
  )
}
