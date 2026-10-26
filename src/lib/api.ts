/**
 * Thin client for the kanban API (kanban/api/shared/routes.mjs). Same-origin, so the
 * SWA login cookie rides along; no tokens live in the browser.
 */

export const COLUMNS = ['backlog', 'todo', 'doing', 'review', 'done'] as const
export type Column = (typeof COLUMNS)[number]

export const COLUMN_LABELS: Record<Column, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  doing: 'Doing',
  review: 'Review',
  done: 'Done',
}

export interface Stamp {
  email: string
  label: string
  at: string
}

export interface Workspace {
  id: string
  name: string
  teamsWebhookUrl?: string // admins only
  hasTeams?: boolean
  projectCount?: number
}

export interface Project {
  id: string
  workspaceId: string
  name: string
  description: string
  repoUrl: string
  archived: boolean
  cardCount?: number
  openCount?: number
}

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

export interface Card {
  id: string
  projectId: string
  workspaceId: string
  title: string
  description: string
  column: Column
  order: number
  assigneeEmail: string | null
  dueDate: string | null
  checklist: ChecklistItem[]
  commentCount: number
  createdBy: Stamp
  updatedBy: Stamp
  projectName?: string
}

export interface Comment {
  id: string
  cardId: string
  body: string
  mentions: string[]
  author: Stamp
  createdAt: string
}

export interface Person {
  email: string
  name: string
}

export type Role = 'admin' | 'member' | 'viewer'

export interface Member extends Person {
  id: string
  role: Role
  workspaceIds: string[]
  /** False for addresses outside the edit domains — they can only ever be viewers. */
  canEdit: boolean
  bootstrapAdmin?: boolean
}

export type KeyScope = 'read' | 'cards' | 'admin'

export const KEY_SCOPE_LABELS: Record<KeyScope, string> = {
  read: 'Read-only',
  cards: 'Cards & comments',
  admin: 'Admin',
}

export interface ApiKeyRecord {
  id: string
  name: string
  scope: KeyScope
  /** Empty means every workspace. */
  workspaceIds: string[]
  expiresAt: string | null
  expired: boolean
  keyPreview: string
  revoked: boolean
  lastUsedAt: string | null
  createdBy: Stamp
}

export interface ActivityEntry {
  id: string
  at: string
  workspaceId: string
  actorId: string
  actor: { type: 'user' | 'key'; email: string; label: string; keyId?: string }
  action: string
  summary: string
  projectId?: string
  cardId?: string
  changes?: Record<string, unknown>
  route: string
  status?: number
}

export interface Me {
  type: 'user' | 'key'
  email: string
  name: string
  role: Role
  isAdmin: boolean
  canEdit: boolean
  editDomains: string[]
  workspaces: Workspace[]
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public email?: string,
  ) {
    super(message)
  }
}

async function send(method: string, path: string, body?: unknown) {
  try {
    return await fetch(`/api/${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      // An expired session makes SWA answer with a redirect to Microsoft sign-in;
      // don't chase it cross-site, just report it.
      redirect: 'manual',
    })
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.')
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await send(method, path, body)
  if (res.type === 'opaqueredirect' || res.status === 302) {
    throw new ApiError(401, 'session_expired', 'Your sign-in has expired.')
  }
  // A signed-in request occasionally arrives without the identity attached. Reads are
  // safe to retry once; a write the server refused for that reason never ran at all.
  if (res.status === 401) {
    await new Promise((r) => setTimeout(r, 400))
    res = await send(method, path, body)
    if (res.type === 'opaqueredirect' || res.status === 302) {
      throw new ApiError(401, 'session_expired', 'Your sign-in has expired.')
    }
  }
  let data: Record<string, unknown> = {}
  try {
    data = await res.json()
  } catch {
    // An HTML error page (e.g. SWA during a deploy) — fall through to the generic error.
  }
  if (!res.ok || data.ok === false) {
    throw new ApiError(
      res.status,
      String(data.error || 'error'),
      String(data.message || data.error || `Request failed (${res.status})`),
      typeof data.email === 'string' ? data.email : undefined,
    )
  }
  return data as T
}

const enc = encodeURIComponent

export const api = {
  me: () => request<Me>('GET', 'me'),

  workspaces: () => request<{ workspaces: Workspace[] }>('GET', 'workspaces'),
  createWorkspace: (name: string) => request<{ workspace: Workspace }>('POST', 'workspaces', { name }),
  updateWorkspace: (id: string, patch: Partial<Pick<Workspace, 'name' | 'teamsWebhookUrl'>>) =>
    request<{ workspace: Workspace }>('PATCH', `workspaces/${enc(id)}`, patch),
  deleteWorkspace: (id: string) => request('DELETE', `workspaces/${enc(id)}`),

  projects: (workspaceId: string, archived = false) =>
    request<{ workspace: Workspace; projects: Project[] }>(
      'GET',
      `workspaces/${enc(workspaceId)}/projects${archived ? '?archived=true' : ''}`,
    ),
  createProject: (workspaceId: string, p: Pick<Project, 'name' | 'description' | 'repoUrl'>) =>
    request<{ project: Project }>('POST', `workspaces/${enc(workspaceId)}/projects`, p),
  board: (projectId: string) =>
    request<{ project: Project; workspace: Workspace; cards: Card[]; members: Person[] }>('GET', `projects/${enc(projectId)}`),
  updateProject: (id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'repoUrl' | 'archived'>>) =>
    request<{ project: Project }>('PATCH', `projects/${enc(id)}`, patch),
  deleteProject: (id: string) => request('DELETE', `projects/${enc(id)}`),

  createCard: (projectId: string, c: { title: string; column: Column }) =>
    request<{ card: Card }>('POST', `projects/${enc(projectId)}/cards`, c),
  card: (id: string) => request<{ card: Card; comments: Comment[] }>('GET', `cards/${enc(id)}`),
  updateCard: (
    id: string,
    patch: Partial<Pick<Card, 'title' | 'description' | 'column' | 'order' | 'assigneeEmail' | 'dueDate' | 'checklist'>>,
  ) => request<{ card: Card }>('PATCH', `cards/${enc(id)}`, patch),
  deleteCard: (id: string) => request('DELETE', `cards/${enc(id)}`),

  addComment: (cardId: string, body: string, mentions: string[]) =>
    request<{ comment: Comment }>('POST', `cards/${enc(cardId)}/comments`, { body, mentions }),
  deleteComment: (id: string) => request('DELETE', `comments/${enc(id)}`),

  search: (q: string) => request<{ cards: Card[] }>('GET', `search?q=${enc(q)}`),

  members: () => request<{ members: Member[] }>('GET', 'members'),
  createMember: (m: { email: string; name: string; role: Role; workspaceIds: string[] }) =>
    request<{ member: Member }>('POST', 'members', m),
  updateMember: (email: string, patch: Partial<Pick<Member, 'name' | 'role' | 'workspaceIds'>>) =>
    request<{ member: Member }>('PATCH', `members/${enc(email)}`, patch),
  deleteMember: (email: string) => request('DELETE', `members/${enc(email)}`),

  keys: () => request<{ keys: ApiKeyRecord[] }>('GET', 'keys'),
  createKey: (k: { name: string; scope: KeyScope; workspaceIds: string[]; expiresInDays: number | null }) =>
    request<{ key: string; record: ApiKeyRecord }>('POST', 'keys', k),
  revokeKey: (id: string) => request('DELETE', `keys/${enc(id)}`),

  activity: (q: { workspaceId?: string; actor?: string; before?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()
    return request<{ entries: ActivityEntry[]; next: string | null }>('GET', `activity${qs ? `?${qs}` : ''}`)
  },
  cardActivity: (id: string) => request<{ entries: ActivityEntry[] }>('GET', `cards/${enc(id)}/activity`),
}

export function errorMessage(err: unknown, fallback = 'Something went wrong.') {
  if (err instanceof ApiError && err.code === 'session_expired') return 'Your sign-in has expired. Reload the page to sign in again.'
  if (err instanceof ApiError && err.status === 401) return "Couldn't confirm your sign-in. Reload the page and try again."
  return err instanceof ApiError ? err.message : fallback
}

/** "2026-11-30" → "30 Nov". Dates are calendar days, so no timezone shifting. */
export function formatDue(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function todayISO() {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function isOverdue(card: Pick<Card, 'dueDate' | 'column'>) {
  return Boolean(card.dueDate && card.column !== 'done' && card.dueDate < todayISO())
}

export function initials(name: string) {
  const parts = name.replace(/@.*/, '').replace(/\(.*?\)/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  return (parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0] || '').toUpperCase()
}

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}
