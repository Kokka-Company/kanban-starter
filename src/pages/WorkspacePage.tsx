import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Github, Plus } from 'lucide-react'
import { api, errorMessage, type Workspace, type Project } from '../lib/api'
import { useMe } from '../lib/me'
import { useAutoRefresh } from '../lib/useAutoRefresh'
import { ErrorNote, PageHeader, Spinner } from '../components/ui'
import WorkspaceMark from '../components/WorkspaceMark'

/** `/w/:workspaceId` — the workspace's projects. Only admins can create them. */
export default function WorkspacePage() {
  const { workspaceId = '' } = useParams()
  const { me } = useMe()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
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

  return (
    <>
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
            {me.isAdmin && !creating && (
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
          No projects yet.{me.isAdmin ? ' Create the first one.' : ' An admin can create one.'}
        </p>
      ) : (
        <ul className="divide-y divide-line glass">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center gap-4 px-5 py-4 hover:bg-muted">
              <Link to={`/p/${p.id}`} className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg">{p.name}</span>
                  {p.archived && <span className="bg-muted px-1.5 text-xs text-fg-muted">Archived</span>}
                </div>
                {p.description && <p className="mt-0.5 truncate text-sm text-fg-subtle">{p.description}</p>}
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
          ))}
        </ul>
      )}
    </>
  )
}

function NewProjectForm({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.createProject(workspaceId, { name, description, repoUrl })
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
