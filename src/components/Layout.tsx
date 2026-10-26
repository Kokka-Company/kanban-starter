import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { LogOut, Search, Settings } from 'lucide-react'
import { useMe } from '../lib/me'
import { Avatar } from './ui'

/** Shown in the header. Set VITE_APP_NAME at build time to rename the app. */
const APP_NAME = import.meta.env.VITE_APP_NAME || 'Kanban'

export default function Layout({ children }: { children: ReactNode }) {
  const { me } = useMe()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get('q') || '')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (q.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(q.trim())}`)
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface text-fg">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            {/* Placeholder mark — replace /favicon.svg and APP_NAME with your own. */}
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="hidden font-semibold text-fg sm:inline">{APP_NAME}</span>
          </Link>

          <form onSubmit={submit} className="mx-auto flex w-full max-w-md items-center">
            <label className="relative w-full">
              <span className="sr-only">Search cards</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search cards…"
                className="w-full border border-line bg-muted py-1.5 pl-8 pr-3 text-sm text-fg placeholder:text-fg-subtle transition focus:border-accent focus:bg-surface focus:outline-none"
              />
            </label>
          </form>

          <nav className="flex shrink-0 items-center gap-1">
            {me.isAdmin && (
              <Link to="/admin" className="p-2 text-fg-subtle hover:text-fg" title="Admin">
                <Settings className="h-5 w-5" />
              </Link>
            )}
            <span className="hidden items-center gap-2 px-2 text-sm text-fg-muted md:flex">
              <Avatar name={me.name} />
              {me.name}
            </span>
            <a href="/logout" className="p-2 text-fg-subtle hover:text-fg" title="Sign out">
              <LogOut className="h-5 w-5" />
            </a>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6">{children}</main>
    </div>
  )
}
