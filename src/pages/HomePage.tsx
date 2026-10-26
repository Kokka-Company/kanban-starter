import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import MyTasksSummary from '../components/MyTasksSummary'
import { ArrowUpRight } from 'lucide-react'
import { api, errorMessage, type Workspace } from '../lib/api'
import { useAutoRefresh } from '../lib/useAutoRefresh'
import WorkspaceMark from '../components/WorkspaceMark'
import { CenteredMessage, ErrorNote, Spinner } from '../components/ui'

/** `/` — one tile per workspace the signed-in person can see. */
export default function HomePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (background = false) => {
    try {
      setWorkspaces((await api.workspaces()).workspaces)
      setError('')
    } catch (err) {
      if (!background) setError(errorMessage(err, 'Could not load workspaces.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useAutoRefresh(() => load(true))

  if (error) return <ErrorNote message={error} />
  if (!workspaces) return <Spinner />
  if (!workspaces.length) {
    return (
      <CenteredMessage title="No workspaces yet">
        <p>You haven't been given access to any workspace. Ask an admin to add you to one.</p>
      </CenteredMessage>
    )
  }

  return (
    <>
      <MyTasksSummary />
      <div className="mb-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Workspaces</h1>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {workspaces.map((a) => (
          <Link
            key={a.id}
            to={`/w/${a.id}`}
            className="glass group flex min-h-48 flex-col justify-between p-6 transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md"
          >
            <WorkspaceMark id={a.id} name={a.name} size={52} />
            <div>
              <h2 className="font-display text-xl font-medium text-fg">{a.name}</h2>
              <div className="mt-3 flex items-center justify-between">
                <span className="font-mono text-xs uppercase tracking-widest text-fg-subtle">
                  <span className="text-fg">{String(a.projectCount ?? 0).padStart(2, '0')}</span> project{a.projectCount === 1 ? '' : 's'}
                </span>
                <ArrowUpRight className="h-5 w-5 text-fg-subtle transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </div>
            </div>
          </Link>
        ))}
      </div>
    </>
  )
}
