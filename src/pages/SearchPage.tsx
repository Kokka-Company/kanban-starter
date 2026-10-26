import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, COLUMN_LABELS, errorMessage, formatDue, isOverdue, type Card } from '../lib/api'
import { useMe } from '../lib/me'
import { ErrorNote, PageHeader, Spinner } from '../components/ui'

/** `/search?q=` — card titles and descriptions across every workspace you can see. */
export default function SearchPage() {
  const [params] = useSearchParams()
  const q = (params.get('q') || '').trim()
  const { me } = useMe()
  const [results, setResults] = useState<Card[] | null>(null)
  const [error, setError] = useState('')
  const workspaceName = Object.fromEntries(me.workspaces.map((a) => [a.id, a.name]))

  useEffect(() => {
    if (q.length < 2) return
    setResults(null)
    setError('')
    api
      .search(q)
      .then((r) => setResults(r.cards))
      .catch((err) => setError(errorMessage(err, 'Search failed.')))
  }, [q])

  return (
    <>
      <PageHeader title={q ? `Results for “${q}”` : 'Search'} />
      {q.length < 2 ? (
        <p className="text-fg-subtle">Type at least 2 characters in the search box above.</p>
      ) : error ? (
        <ErrorNote message={error} />
      ) : !results ? (
        <Spinner />
      ) : results.length === 0 ? (
        <p className="text-fg-subtle">No cards match.</p>
      ) : (
        <ul className="divide-y divide-line glass">
          {results.map((c) => (
            <li key={c.id}>
              <Link to={`/p/${c.projectId}?card=${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-muted">
                {c.key && <span className="font-mono text-xs text-fg-subtle">{c.key}</span>}
                <span className="min-w-0 flex-1 font-medium text-fg">{c.title}</span>
                {c.delayed && <span className="border border-amber-400/50 bg-amber-400/10 px-1.5 text-xs text-amber-800" title={c.delayReason}>Delayed</span>}
                <span className="text-sm text-fg-subtle">
                  {workspaceName[c.workspaceId] || c.workspaceId} / {c.projectName}
                </span>
                {c.dueDate && (
                  <span className={`text-xs ${isOverdue(c) ? 'text-red-600' : 'text-fg-subtle'}`}>Due {formatDue(c.dueDate)}</span>
                )}
                <span className="bg-muted px-2 py-0.5 text-xs text-fg-muted">{COLUMN_LABELS[c.column]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {results?.length === 50 && <p className="mt-2 text-xs text-fg-subtle">Showing the first 50 matches. Try a more specific search.</p>}
    </>
  )
}
