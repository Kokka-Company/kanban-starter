import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { api, ApiError, type Label, type LabelColor, type Me } from './lib/api'
import { LabelsContext } from './lib/labels'
import { MeContext } from './lib/me'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import WorkspacePage from './pages/WorkspacePage'
import ProjectPage from './pages/ProjectPage'
import SearchPage from './pages/SearchPage'
import AdminPage from './pages/AdminPage'
import CalendarPage from './pages/CalendarPage'
import { CenteredMessage, Spinner } from './components/ui'

/** Loads the shared label list once; pickers call reload() after creating one. */
function LabelsProvider({ children }: { children: ReactNode }) {
  const [labels, setLabels] = useState<Label[]>([])
  const [colors, setColors] = useState<LabelColor[]>([])
  const reload = useCallback(async () => {
    try {
      const r = await api.labels()
      setLabels(r.labels)
      setColors(r.colors)
    } catch {
      // Labels are decoration; a failed load just shows none until the next try.
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  return <LabelsContext.Provider value={{ labels, colors, reload }}>{children}</LabelsContext.Provider>
}

const REDIRECT_KEY = 'kanban.loginRedirectAt'

function recentlyRedirected() {
  try {
    return Date.now() - Number(sessionStorage.getItem(REDIRECT_KEY) || 0) < 60_000
  } catch {
    return false
  }
}

function markRedirected() {
  try {
    sessionStorage.setItem(REDIRECT_KEY, String(Date.now()))
  } catch {
    // Storage blocked: worst case we redirect once more, never in a tight loop of our own.
  }
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  const load = useCallback(async () => {
    try {
      setMe(await api.me())
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'network', 'Could not reach the server.'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (error?.status === 401) {
    // SWA sends signed-out visitors to Microsoft before the app even loads, so a 401
    // here means the session expired or the request lost its identity. Go round the
    // sign-in once; if that didn't help, stop and say so instead of looping.
    if (!recentlyRedirected()) {
      markRedirected()
      window.location.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(window.location.pathname + window.location.search)}`
      return null
    }
    return (
      <CenteredMessage title="Couldn't confirm your sign-in">
        <p>You signed in, but the server didn't receive it. This is usually temporary.</p>
        <div className="mt-4 flex justify-center gap-2">
          <button className="btn-primary" onClick={() => void load()}>Try again</button>
          <a className="btn-ghost border border-line-strong" href="/logout">Sign out and back in</a>
        </div>
      </CenteredMessage>
    )
  }

  if (error?.code === 'not_a_member') {
    return (
      <CenteredMessage title="You don't have access yet">
        <p>
          You're signed in as <strong>{error.email}</strong>, but that account hasn't been added to this board.
          Ask an admin to add you.
        </p>
        <a className="btn-ghost mt-4 border border-line-strong" href="/logout">
          Sign in with a different account
        </a>
      </CenteredMessage>
    )
  }

  if (error) {
    return (
      <CenteredMessage title="Something went wrong">
        <p>{error.message}</p>
        <button className="btn-primary mt-4" onClick={() => void load()}>
          Try again
        </button>
      </CenteredMessage>
    )
  }

  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <MeContext.Provider value={{ me, reload: load }}>
      <LabelsProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/w/:workspaceId" element={<WorkspacePage />} />
            <Route path="/p/:projectId" element={<ProjectPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            {me.isAdmin && <Route path="/admin" element={<AdminPage />} />}
            <Route path="*" element={<CenteredMessage title="Page not found" />} />
          </Routes>
        </Layout>
      </BrowserRouter>
      </LabelsProvider>
    </MeContext.Provider>
  )
}
