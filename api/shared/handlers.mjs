import { randomUUID } from 'node:crypto'
import {
  canAccessWorkspace,
  canEmailEdit,
  editDomains,
  effectiveRole,
  stamp,
  generateKey,
  hashKey,
  bootstrapAdmins,
  KEY_SCOPES,
} from './auth.mjs'
import { isAllowedWebhookUrl, notifyAssigned, notifyMentioned } from './teams.mjs'

/**
 * Every API endpoint. A handler gets
 *   { actor, params, query, body, store, env, logger }
 * and returns { status, body, audit? } or throws HttpError. The same functions back
 * the web app and the AI/API-key surface — there is deliberately no second API.
 *
 * `audit` describes a change for the activity log; runRoute writes it. Every write
 * handler returns one, so nothing changes without a record.
 */

export const COLUMNS = ['backlog', 'todo', 'doing', 'review', 'done']
const ORDER_STEP = 1000
export const KEY_EXPIRY_DAYS = [30, 90, 365]

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * @param {any} body
 * @param {number} [status]
 * @param {{ action: string, summary: string, workspaceId?: string, projectId?: string, cardId?: string, changes?: object }} [audit]
 */
const ok = (body, status = 200, audit = undefined) => ({ status, body, audit })
const notFound = (what) => new HttpError(404, 'not_found', `${what} not found`)

// --- validation -----------------------------------------------------------------

function text(value, field, { max = 200, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, 'invalid_input', `${field} is required`)
    return ''
  }
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_input', `${field} must be a string`)
  const v = value.trim()
  if (required && !v) throw new HttpError(400, 'invalid_input', `${field} is required`)
  if (v.length > max) throw new HttpError(400, 'invalid_input', `${field} is longer than ${max} characters`)
  return v
}

function optionalUrl(value, field) {
  const v = text(value, field, { max: 500 })
  if (!v) return ''
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error()
  } catch {
    throw new HttpError(400, 'invalid_input', `${field} must be an http(s) URL`)
  }
  return v
}

function optionalDate(value, field) {
  if (value === null || value === '' || value === undefined) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, 'invalid_input', `${field} must be YYYY-MM-DD`)
  }
  return value
}

function email(value, field = 'email') {
  const v = text(value, field, { max: 254, required: true }).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, 'invalid_input', `${field} is not an email`)
  return v
}

function column(value) {
  if (!COLUMNS.includes(value)) {
    throw new HttpError(400, 'invalid_input', `column must be one of ${COLUMNS.join(', ')}`)
  }
  return value
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function checklist(value) {
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid_input', 'checklist must be an array')
  if (value.length > 100) throw new HttpError(400, 'invalid_input', 'checklist has more than 100 items')
  return value.map((item, i) => ({
    id: typeof item?.id === 'string' && item.id ? item.id.slice(0, 64) : randomUUID(),
    text: text(item?.text, `checklist[${i}].text`, { max: 500, required: true }),
    done: Boolean(item?.done),
  }))
}

async function knownWorkspaceIds(store, ids, field = 'workspaceIds') {
  if (!Array.isArray(ids)) throw new HttpError(400, 'invalid_input', `${field} must be an array`)
  const known = new Set((await store.find('workspaces')).map((a) => a.id))
  const bad = ids.filter((id) => !known.has(id))
  if (bad.length) throw new HttpError(400, 'invalid_input', `Unknown workspaces: ${bad.join(', ')}`)
  return [...new Set(ids)]
}

// --- permission checks ------------------------------------------------------------

function requireAdmin(actor) {
  if (!actor.isAdmin) throw new HttpError(403, 'admin_only', 'Only admins can do that')
}

/** People and keys control who gets in; a key — even an admin key — may never change them. */
function requireHumanAdmin(actor) {
  requireAdmin(actor)
  if (actor.type !== 'user') {
    throw new HttpError(403, 'human_admin_only', 'Only a signed-in admin can manage people and API keys')
  }
}

function requireEdit(actor) {
  if (!actor.canEdit) throw new HttpError(403, 'read_only', 'You have view-only access')
}

// --- loaders that enforce access ------------------------------------------------

async function loadWorkspace(store, actor, id) {
  const workspace = await store.get('workspaces', id)
  if (!workspace || !canAccessWorkspace(actor, workspace.id)) throw notFound('Workspace')
  return workspace
}

async function loadProject(store, actor, id) {
  const project = await store.get('projects', id)
  if (!project || !canAccessWorkspace(actor, project.workspaceId)) throw notFound('Project')
  return project
}

async function loadCard(store, actor, id) {
  const card = await store.get('cards', id)
  if (!card || !canAccessWorkspace(actor, card.workspaceId)) throw notFound('Card')
  return card
}

/** The webhook URL is a secret of sorts: only admins see it. */
function publicWorkspace(workspace, actor) {
  const { teamsWebhookUrl, ...rest } = workspace
  return actor.isAdmin ? { ...workspace, teamsWebhookUrl: teamsWebhookUrl || '' } : { ...rest, hasTeams: Boolean(teamsWebhookUrl) }
}

function publicMember(m) {
  return { email: m.email, name: m.name || m.email }
}

/** People who can see an workspace (for assigning and @mentions): its members plus every admin. */
async function workspacePeople(store, env, workspaceId) {
  const all = await store.find('members')
  return all
    .filter((m) => effectiveRole(m, env) === 'admin' || (m.workspaceIds || []).includes(workspaceId))
    .map(publicMember)
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function nextOrder(store, projectId, col) {
  const cards = await store.find('cards', { projectId, column: col })
  return cards.reduce((max, c) => Math.max(max, c.order || 0), 0) + ORDER_STEP
}

const short = (s, n = 300) => (s && s.length > n ? `${s.slice(0, n)}…` : s)

// --- seed -----------------------------------------------------------------------

/**
 * Workspaces created on first start, from KANBAN_SEED_WORKSPACES (comma-separated
 * names, e.g. "Engineering,Marketing,Operations"). Admins can add more in the app.
 */
export function seedWorkspaces(env) {
  const names = String(env.KANBAN_SEED_WORKSPACES || 'General')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  return names.map((name) => ({ id: slug(name) || randomUUID(), name }))
}

let seeded = false
export async function ensureSeed(store, env) {
  if (seeded) return
  const existing = await store.find('workspaces')
  if (!existing.length) {
    const now = new Date().toISOString()
    for (const w of seedWorkspaces(env)) await store.put('workspaces', { ...w, teamsWebhookUrl: '', createdAt: now })
  }
  seeded = true
}

// --- me ---------------------------------------------------------------------------

export async function getMe({ actor, store, env }) {
  const workspaces = (await store.find('workspaces')).filter((a) => canAccessWorkspace(actor, a.id))
  return ok({
    type: actor.type,
    email: actor.email,
    name: actor.name,
    role: actor.role,
    isAdmin: actor.isAdmin,
    canEdit: actor.canEdit,
    editDomains: editDomains(env),
    workspaces: workspaces.map((a) => publicWorkspace(a, actor)).sort((a, b) => a.name.localeCompare(b.name)),
  })
}

// --- workspaces -------------------------------------------------------------------

export async function listWorkspaces({ actor, store }) {
  const workspaces = (await store.find('workspaces')).filter((a) => canAccessWorkspace(actor, a.id))
  const projects = await store.find('projects', { workspaceId: { in: workspaces.map((a) => a.id) } })
  return ok({
    workspaces: workspaces
      .map((a) => ({
        ...publicWorkspace(a, actor),
        projectCount: projects.filter((p) => p.workspaceId === a.id && !p.archived).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
}

export async function createWorkspace({ actor, store, body }) {
  requireAdmin(actor)
  const name = text(body.name, 'name', { max: 80, required: true })
  const id = slug(name) || randomUUID()
  if (await store.get('workspaces', id)) throw new HttpError(409, 'exists', 'An workspace with that name already exists')
  const workspace = await store.put('workspaces', { id, name, teamsWebhookUrl: '', createdAt: new Date().toISOString() })
  return ok({ workspace: publicWorkspace(workspace, actor) }, 201, {
    action: 'workspace.create',
    summary: `created workspace "${name}"`,
    workspaceId: id,
  })
}

export async function updateWorkspace({ actor, store, params, body }) {
  requireAdmin(actor)
  const workspace = await loadWorkspace(store, actor, params.id)
  const next = { ...workspace }
  const changes = {}
  if ('name' in body) {
    next.name = text(body.name, 'name', { max: 80, required: true })
    if (next.name !== workspace.name) changes.name = { from: workspace.name, to: next.name }
  }
  if ('teamsWebhookUrl' in body) {
    const url = text(body.teamsWebhookUrl, 'teamsWebhookUrl', { max: 2000 })
    if (url && !isAllowedWebhookUrl(url)) {
      throw new HttpError(400, 'invalid_input', 'teamsWebhookUrl must be an https Teams Workflows webhook URL')
    }
    next.teamsWebhookUrl = url
    // The URL itself is a credential, so the log only says whether it was set.
    if (url !== (workspace.teamsWebhookUrl || '')) changes.teamsWebhook = { from: workspace.teamsWebhookUrl ? 'set' : 'none', to: url ? 'set' : 'none' }
  }
  const saved = await store.put('workspaces', next)
  return ok({ workspace: publicWorkspace(saved, actor) }, 200, {
    action: 'workspace.update',
    summary: `updated workspace "${saved.name}"`,
    workspaceId: saved.id,
    changes,
  })
}

export async function deleteWorkspace({ actor, store, params }) {
  requireAdmin(actor)
  const workspace = await loadWorkspace(store, actor, params.id)
  const projects = await store.find('projects', { workspaceId: workspace.id })
  if (projects.length) throw new HttpError(409, 'not_empty', 'Delete or move its projects first')
  await store.remove('workspaces', workspace)
  return ok({ deleted: true }, 200, { action: 'workspace.delete', summary: `deleted workspace "${workspace.name}"`, workspaceId: workspace.id })
}

export async function listWorkspaceMembers({ actor, store, env, params }) {
  const workspace = await loadWorkspace(store, actor, params.id)
  return ok({ members: await workspacePeople(store, env, workspace.id) })
}

// --- projects -------------------------------------------------------------------

export async function listProjects({ actor, store, params, query }) {
  const workspace = await loadWorkspace(store, actor, params.id)
  let projects = await store.find('projects', { workspaceId: workspace.id })
  if (query.archived !== 'true') projects = projects.filter((p) => !p.archived)
  const cards = await store.find('cards', { workspaceId: workspace.id })
  return ok({
    workspace: publicWorkspace(workspace, actor),
    projects: projects
      .map((p) => {
        const mine = cards.filter((c) => c.projectId === p.id)
        return { ...p, cardCount: mine.length, openCount: mine.filter((c) => c.column !== 'done').length }
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
}

export async function createProject({ actor, store, params, body }) {
  requireAdmin(actor)
  const workspace = await loadWorkspace(store, actor, params.id)
  const project = await store.put('projects', {
    id: randomUUID(),
    workspaceId: workspace.id,
    name: text(body.name, 'name', { max: 120, required: true }),
    description: text(body.description, 'description', { max: 2000 }),
    repoUrl: optionalUrl(body.repoUrl, 'repoUrl'),
    archived: false,
    createdBy: stamp(actor),
  })
  return ok({ project }, 201, {
    action: 'project.create',
    summary: `created project "${project.name}"`,
    workspaceId: workspace.id,
    projectId: project.id,
  })
}

/** Everything the board screen needs in one round trip. */
export async function getProject({ actor, store, env, params }) {
  const project = await loadProject(store, actor, params.id)
  const [workspace, cards, members] = await Promise.all([
    store.get('workspaces', project.workspaceId),
    store.find('cards', { projectId: project.id }),
    workspacePeople(store, env, project.workspaceId),
  ])
  return ok({
    project,
    workspace: publicWorkspace(workspace, actor),
    columns: COLUMNS,
    cards: cards.sort((a, b) => a.order - b.order),
    members,
  })
}

export async function updateProject({ actor, store, params, body }) {
  requireAdmin(actor)
  const project = await loadProject(store, actor, params.id)
  const next = { ...project }
  if ('name' in body) next.name = text(body.name, 'name', { max: 120, required: true })
  if ('description' in body) next.description = text(body.description, 'description', { max: 2000 })
  if ('repoUrl' in body) next.repoUrl = optionalUrl(body.repoUrl, 'repoUrl')
  if ('archived' in body) next.archived = Boolean(body.archived)
  const changes = {}
  for (const f of ['name', 'description', 'repoUrl', 'archived']) {
    if (next[f] !== project[f]) changes[f] = { from: short(project[f]), to: short(next[f]) }
  }
  next.updatedBy = stamp(actor)
  const saved = await store.put('projects', next)
  return ok({ project: saved }, 200, {
    action: 'project.update',
    summary: `updated project "${saved.name}"`,
    workspaceId: saved.workspaceId,
    projectId: saved.id,
    changes,
  })
}

export async function deleteProject({ actor, store, params }) {
  requireAdmin(actor)
  const project = await loadProject(store, actor, params.id)
  const cards = await store.find('cards', { projectId: project.id })
  for (const card of cards) {
    for (const c of await store.find('comments', { cardId: card.id })) await store.remove('comments', c)
    await store.remove('cards', card)
  }
  await store.remove('projects', project)
  return ok({ deleted: true, cardsDeleted: cards.length }, 200, {
    action: 'project.delete',
    summary: `deleted project "${project.name}" and its ${cards.length} card${cards.length === 1 ? '' : 's'}`,
    workspaceId: project.workspaceId,
    projectId: project.id,
  })
}

// --- cards ------------------------------------------------------------------------

export async function listCards({ actor, store, params, query }) {
  const project = await loadProject(store, actor, params.id)
  const where = { projectId: project.id }
  if (query.column) where.column = column(query.column)
  if (query.assignee) where.assigneeEmail = String(query.assignee).toLowerCase()
  const cards = await store.find('cards', where)
  return ok({ cards: cards.sort((a, b) => a.order - b.order) })
}

async function resolveAssignee(store, env, workspaceId, value) {
  if (value === null || value === '' || value === undefined) return null
  const addr = email(value, 'assigneeEmail')
  const person = (await workspacePeople(store, env, workspaceId)).find((p) => p.email === addr)
  if (!person) throw new HttpError(400, 'invalid_input', `${addr} does not have access to this workspace`)
  return person
}

export async function createCard({ actor, store, env, logger, params, body }) {
  requireEdit(actor)
  const project = await loadProject(store, actor, params.id)
  const col = body.column === undefined ? 'backlog' : column(body.column)
  const assignee = await resolveAssignee(store, env, project.workspaceId, body.assigneeEmail)
  const now = stamp(actor)
  const card = await store.put('cards', {
    id: randomUUID(),
    projectId: project.id,
    workspaceId: project.workspaceId,
    title: text(body.title, 'title', { max: 200, required: true }),
    description: text(body.description, 'description', { max: 10000 }),
    column: col,
    order: typeof body.order === 'number' && Number.isFinite(body.order) ? body.order : await nextOrder(store, project.id, col),
    assigneeEmail: assignee?.email || null,
    dueDate: optionalDate(body.dueDate, 'dueDate'),
    checklist: body.checklist === undefined ? [] : checklist(body.checklist),
    commentCount: 0,
    createdBy: now,
    updatedBy: now,
  })
  if (assignee) {
    const workspace = await store.get('workspaces', project.workspaceId)
    await notifyAssigned({ env, logger, workspace, project, card, assignee, actor })
  }
  return ok({ card }, 201, {
    action: 'card.create',
    summary: `created card "${card.title}" in ${project.name}`,
    workspaceId: card.workspaceId,
    projectId: card.projectId,
    cardId: card.id,
  })
}

export async function getCard({ actor, store, params }) {
  const card = await loadCard(store, actor, params.id)
  const comments = await store.find('comments', { cardId: card.id })
  return ok({ card, comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) })
}

const checklistSummary = (items) => `${items.filter((i) => i.done).length}/${items.length} done`

/** Old → new for every card field a PATCH touched (order is noise from dragging, so it's left out). */
function cardChanges(before, after) {
  const changes = {}
  for (const f of ['title', 'column', 'assigneeEmail', 'dueDate']) {
    if (before[f] !== after[f]) changes[f] = { from: before[f] ?? null, to: after[f] ?? null }
  }
  if (before.description !== after.description) {
    changes.description = { from: short(before.description), to: short(after.description) }
  }
  if (JSON.stringify(before.checklist) !== JSON.stringify(after.checklist)) {
    const added = after.checklist.filter((i) => !before.checklist.some((b) => b.id === i.id)).map((i) => i.text)
    const removed = before.checklist.filter((b) => !after.checklist.some((i) => i.id === b.id)).map((i) => i.text)
    changes.checklist = {
      from: checklistSummary(before.checklist),
      to: checklistSummary(after.checklist),
      ...(added.length ? { added } : {}),
      ...(removed.length ? { removed } : {}),
    }
  }
  return changes
}

function describeCardChange(card, changes) {
  if (changes.column) return `moved "${card.title}" from ${changes.column.from} to ${changes.column.to}`
  if (changes.assigneeEmail) {
    return changes.assigneeEmail.to ? `assigned "${card.title}" to ${changes.assigneeEmail.to}` : `unassigned "${card.title}"`
  }
  const fields = Object.keys(changes)
  if (!fields.length) return `reordered "${card.title}"`
  return `updated ${fields.join(', ')} on "${card.title}"`
}

export async function updateCard({ actor, store, env, logger, params, body }) {
  requireEdit(actor)
  const card = await loadCard(store, actor, params.id)
  const next = { ...card }
  if ('title' in body) next.title = text(body.title, 'title', { max: 200, required: true })
  if ('description' in body) next.description = text(body.description, 'description', { max: 10000 })
  if ('dueDate' in body) next.dueDate = optionalDate(body.dueDate, 'dueDate')
  if ('checklist' in body) next.checklist = checklist(body.checklist)

  let newAssignee = null
  if ('assigneeEmail' in body) {
    newAssignee = await resolveAssignee(store, env, card.workspaceId, body.assigneeEmail)
    next.assigneeEmail = newAssignee?.email || null
  }

  if ('column' in body) next.column = column(body.column)
  if ('order' in body) {
    if (typeof body.order !== 'number' || !Number.isFinite(body.order)) {
      throw new HttpError(400, 'invalid_input', 'order must be a number')
    }
    next.order = body.order
  } else if (next.column !== card.column) {
    next.order = await nextOrder(store, card.projectId, next.column)
  }

  next.updatedBy = stamp(actor)
  const saved = await store.put('cards', next)
  const changes = cardChanges(card, saved)

  if (newAssignee && newAssignee.email !== card.assigneeEmail) {
    const [workspace, project] = await Promise.all([
      store.get('workspaces', card.workspaceId),
      store.get('projects', card.projectId),
    ])
    await notifyAssigned({ env, logger, workspace, project, card: saved, assignee: newAssignee, actor })
  }
  return ok({ card: saved }, 200, {
    action: changes.column ? 'card.move' : 'card.update',
    summary: describeCardChange(saved, changes),
    workspaceId: saved.workspaceId,
    projectId: saved.projectId,
    cardId: saved.id,
    changes,
  })
}

export async function deleteCard({ actor, store, params }) {
  requireEdit(actor)
  const card = await loadCard(store, actor, params.id)
  const comments = await store.find('comments', { cardId: card.id })
  for (const c of comments) await store.remove('comments', c)
  await store.remove('cards', card)
  return ok({ deleted: true }, 200, {
    action: 'card.delete',
    summary: `deleted card "${card.title}"${comments.length ? ` and ${comments.length} comment${comments.length === 1 ? '' : 's'}` : ''}`,
    workspaceId: card.workspaceId,
    projectId: card.projectId,
    cardId: card.id,
    // A deleted card is gone for good, so keep what it said.
    changes: { snapshot: { title: card.title, column: card.column, assigneeEmail: card.assigneeEmail, dueDate: card.dueDate, description: short(card.description) } },
  })
}

// --- comments ---------------------------------------------------------------------

/** "@someone@company.com" anywhere in the text, plus whatever the UI's @-picker sent. */
function mentionedEmails(bodyText, explicit) {
  const found = new Set()
  for (const m of bodyText.matchAll(/@([^\s@]+@[^\s@]+\.[A-Za-z]{2,})/g)) found.add(m[1].toLowerCase())
  if (Array.isArray(explicit)) for (const e of explicit) if (typeof e === 'string') found.add(e.toLowerCase())
  return found
}

export async function listComments({ actor, store, params }) {
  const card = await loadCard(store, actor, params.id)
  const comments = await store.find('comments', { cardId: card.id })
  return ok({ comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) })
}

export async function createComment({ actor, store, env, logger, params, body }) {
  requireEdit(actor)
  const card = await loadCard(store, actor, params.id)
  const bodyText = text(body.body, 'body', { max: 5000, required: true })
  const people = await workspacePeople(store, env, card.workspaceId)
  const wanted = mentionedEmails(bodyText, body.mentions)
  const mentioned = people.filter((p) => wanted.has(p.email)) // silently drop people outside the workspace

  const comment = await store.put('comments', {
    id: randomUUID(),
    cardId: card.id,
    workspaceId: card.workspaceId,
    body: bodyText,
    mentions: mentioned.map((p) => p.email),
    author: stamp(actor),
    createdAt: new Date().toISOString(),
  })
  await store.put('cards', { ...card, commentCount: (card.commentCount || 0) + 1 })

  if (mentioned.length) {
    const [workspace, project] = await Promise.all([
      store.get('workspaces', card.workspaceId),
      store.get('projects', card.projectId),
    ])
    await notifyMentioned({ env, logger, workspace, project, card, people: mentioned, comment, actor })
  }
  return ok({ comment }, 201, {
    action: 'comment.create',
    summary: `commented on "${card.title}"`,
    workspaceId: card.workspaceId,
    projectId: card.projectId,
    cardId: card.id,
    changes: { body: short(bodyText), ...(mentioned.length ? { mentions: comment.mentions } : {}) },
  })
}

export async function deleteComment({ actor, store, params }) {
  const comment = await store.get('comments', params.id)
  if (!comment || !canAccessWorkspace(actor, comment.workspaceId)) throw notFound('Comment')
  const isAuthor = comment.author?.email ? comment.author.email === actor.email : false
  if (!actor.isAdmin && !(isAuthor && actor.canEdit)) {
    throw new HttpError(403, 'forbidden', 'You can only delete your own comments')
  }
  await store.remove('comments', comment)
  const card = await store.get('cards', comment.cardId)
  if (card) await store.put('cards', { ...card, commentCount: Math.max(0, (card.commentCount || 1) - 1) })
  return ok({ deleted: true }, 200, {
    action: 'comment.delete',
    summary: `deleted a comment by ${comment.author?.label || 'someone'}${card ? ` on "${card.title}"` : ''}`,
    workspaceId: comment.workspaceId,
    projectId: card?.projectId,
    cardId: comment.cardId,
    changes: { body: short(comment.body) },
  })
}

// --- search -----------------------------------------------------------------------

export async function search({ actor, store, query }) {
  const q = text(query.q, 'q', { max: 100, required: true })
  if (q.length < 2) throw new HttpError(400, 'invalid_input', 'Search for at least 2 characters')
  let workspaceIds = (await store.find('workspaces')).filter((a) => canAccessWorkspace(actor, a.id)).map((a) => a.id)
  if (query.workspaceId) workspaceIds = workspaceIds.filter((id) => id === query.workspaceId)
  if (!workspaceIds.length) return ok({ cards: [] })

  const cards = await store.find(
    'cards',
    { workspaceId: { in: workspaceIds } },
    { contains: { fields: ['title', 'description'], text: q }, limit: 50 },
  )
  const projectIds = [...new Set(cards.map((c) => c.projectId))]
  const projects = projectIds.length ? await store.find('projects', { id: { in: projectIds } }) : []
  const nameOf = Object.fromEntries(projects.map((p) => [p.id, p.name]))
  return ok({ cards: cards.map((c) => ({ ...c, projectName: nameOf[c.projectId] || '' })) })
}

// --- members (human admins) ---------------------------------------------------------

const ROLES = ['admin', 'member', 'viewer']

async function memberInput(store, env, addr, body, { partial = false } = {}) {
  const out = {}
  if (!partial || 'name' in body) out.name = text(body.name, 'name', { max: 80 })
  if (!partial || 'role' in body) {
    const role = body.role ?? 'member'
    if (!ROLES.includes(role)) throw new HttpError(400, 'invalid_input', 'role must be admin, member or viewer')
    if (role !== 'viewer' && !canEmailEdit(addr, env)) {
      throw new HttpError(
        400,
        'view_only_domain',
        `Only @${editDomains(env).join(', @')} addresses can edit. Add ${addr} as a viewer instead.`,
      )
    }
    out.role = role
  }
  if (!partial || 'workspaceIds' in body) out.workspaceIds = await knownWorkspaceIds(store, body.workspaceIds ?? [])
  return out
}

function publicMemberRecord(m, env) {
  return { ...m, role: effectiveRole(m, env), canEdit: canEmailEdit(m.email, env), bootstrapAdmin: bootstrapAdmins(env).includes(m.email) }
}

export async function listMembers({ actor, store, env }) {
  requireAdmin(actor)
  const members = await store.find('members')
  return ok({
    members: members
      .map((m) => publicMemberRecord(m, env))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)),
  })
}

export async function createMember({ actor, store, env, body }) {
  requireHumanAdmin(actor)
  const addr = email(body.email)
  if (await store.get('members', addr)) throw new HttpError(409, 'exists', 'That person is already a member')
  // Outside the edit domains the only choice is viewer, so default to it rather than refuse.
  const input = { ...body, role: body.role ?? (canEmailEdit(addr, env) ? 'member' : 'viewer') }
  const fields = await memberInput(store, env, addr, input)
  const member = await store.put('members', {
    id: addr,
    email: addr,
    ...fields,
    name: fields.name || addr.split('@')[0],
    createdAt: new Date().toISOString(),
    createdBy: stamp(actor),
  })
  return ok({ member: publicMemberRecord(member, env) }, 201, {
    action: 'member.create',
    summary: `added ${addr} as ${member.role}`,
    changes: { role: member.role, workspaceIds: member.workspaceIds },
  })
}

export async function updateMember({ actor, store, env, params, body }) {
  requireHumanAdmin(actor)
  const member = await store.get('members', String(params.email).toLowerCase())
  if (!member) throw notFound('Member')
  const fields = await memberInput(store, env, member.email, body, { partial: true })
  if (member.email === actor.email && fields.role && fields.role !== 'admin') {
    throw new HttpError(400, 'invalid_input', "You can't remove your own admin rights")
  }
  const saved = await store.put('members', { ...member, ...fields, name: fields.name || member.name })
  const changes = {}
  for (const f of ['name', 'role']) if (saved[f] !== member[f]) changes[f] = { from: member[f], to: saved[f] }
  if (JSON.stringify(saved.workspaceIds) !== JSON.stringify(member.workspaceIds)) {
    changes.workspaceIds = { from: member.workspaceIds, to: saved.workspaceIds }
  }
  return ok({ member: publicMemberRecord(saved, env) }, 200, {
    action: 'member.update',
    summary: `changed access for ${member.email}`,
    changes,
  })
}

export async function deleteMember({ actor, store, params }) {
  requireHumanAdmin(actor)
  const member = await store.get('members', String(params.email).toLowerCase())
  if (!member) throw notFound('Member')
  if (member.email === actor.email) throw new HttpError(400, 'invalid_input', "You can't remove yourself")
  await store.remove('members', member)
  return ok({ deleted: true }, 200, {
    action: 'member.delete',
    summary: `removed ${member.email}`,
    changes: { role: member.role, workspaceIds: member.workspaceIds },
  })
}

// --- API keys (human admins) --------------------------------------------------------

function publicKey(k) {
  const { sha256Hash, ...rest } = k
  return {
    ...rest,
    scope: KEY_SCOPES.includes(k.scope) ? k.scope : 'admin',
    workspaceIds: k.workspaceIds || [],
    expiresAt: k.expiresAt || null,
    expired: Boolean(k.expiresAt && Date.parse(k.expiresAt) <= Date.now()),
  }
}

export async function listKeys({ actor, store }) {
  requireHumanAdmin(actor)
  const keys = await store.find('apiKeys')
  return ok({ keys: keys.map(publicKey).sort((a, b) => b.createdBy.at.localeCompare(a.createdBy.at)) })
}

export async function createKey({ actor, store, body }) {
  requireHumanAdmin(actor)
  const name = text(body.name, 'name', { max: 60, required: true })
  const scope = body.scope ?? 'cards'
  if (!KEY_SCOPES.includes(scope)) throw new HttpError(400, 'invalid_input', `scope must be one of ${KEY_SCOPES.join(', ')}`)
  // Admin keys manage workspaces, so they can't be fenced into some of them.
  const workspaceIds = scope === 'admin' ? [] : await knownWorkspaceIds(store, body.workspaceIds ?? [])
  // null is a real choice (never expires); only a missing field means the default.
  const days = 'expiresInDays' in body ? body.expiresInDays : 90
  if (days !== null && !KEY_EXPIRY_DAYS.includes(days)) {
    throw new HttpError(400, 'invalid_input', `expiresInDays must be one of ${KEY_EXPIRY_DAYS.join(', ')} or null`)
  }
  const key = generateKey()
  const record = await store.put('apiKeys', {
    id: randomUUID(),
    name,
    scope,
    workspaceIds,
    expiresAt: days === null ? null : new Date(Date.now() + days * 86400000).toISOString(),
    sha256Hash: hashKey(key),
    keyPreview: `${key.slice(0, 7)}…${key.slice(-4)}`,
    revoked: false,
    lastUsedAt: null,
    createdBy: stamp(actor),
  })
  // The only time the plain key is ever returned.
  return ok({ key, record: publicKey(record) }, 201, {
    action: 'key.create',
    summary: `created API key "${name}" (${scope}${workspaceIds.length ? `, ${workspaceIds.join(', ')}` : ', all workspaces'}, ${days === null ? 'never expires' : `expires in ${days} days`})`,
    changes: { keyId: record.id, scope, workspaceIds, expiresAt: record.expiresAt },
  })
}

export async function revokeKey({ actor, store, params }) {
  requireHumanAdmin(actor)
  const record = await store.get('apiKeys', params.id)
  if (!record) throw notFound('Key')
  const saved = await store.put('apiKeys', { ...record, revoked: true, revokedBy: stamp(actor) })
  return ok({ record: publicKey(saved) }, 200, {
    action: 'key.revoke',
    summary: `revoked API key "${record.name}"`,
    changes: { keyId: record.id },
  })
}

// --- activity log -----------------------------------------------------------------

const PAGE = 50

/** The whole log, newest first. Admins only; filter by workspace, by who, and page with `before`. */
export async function listActivity({ actor, store, query }) {
  requireAdmin(actor)
  const where = {}
  if (query.workspaceId) where.workspaceId = String(query.workspaceId)
  if (query.actor) where.actorId = String(query.actor).toLowerCase()
  if (query.before) where.at = { lt: String(query.before) }
  const limit = Math.min(Number(query.limit) || PAGE, 200)
  const entries = await store.find('activity', where, { orderBy: { field: 'at', desc: true }, limit })
  return ok({ entries, next: entries.length === limit ? entries[entries.length - 1].at : null })
}

/** One card's history — anyone who can see the card can see what happened to it. */
export async function cardActivity({ actor, store, params }) {
  const card = await loadCard(store, actor, params.id)
  const entries = await store.find(
    'activity',
    { workspaceId: card.workspaceId, cardId: card.id },
    { orderBy: { field: 'at', desc: true }, limit: 100 },
  )
  return ok({ entries })
}
