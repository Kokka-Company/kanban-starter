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

/**
 * Projects: any signed-in editor (members included, #2) in their own workspaces. A
 * "Cards & comments" key promises it can't touch projects, so keys need the admin scope.
 */
function requireProjectEdit(actor) {
  requireEdit(actor)
  if (actor.type === 'key' && !actor.isAdmin) {
    throw new HttpError(403, 'admin_key_only', 'This key can change cards and comments only; projects need an admin key')
  }
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

// --- seed & migrations ------------------------------------------------------------

/**
 * Workspaces created on first start, from KANBAN_SEED_WORKSPACES (comma-separated
 * names, e.g. "Engineering,Marketing,Operations"). Admins can add more in the app.
 */
export function seedWorkspaces(env) {
  const names = String(env.KANBAN_SEED_WORKSPACES || 'General')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  const taken = new Set()
  return names.map((name) => {
    const prefix = defaultPrefix(name, taken)
    taken.add(prefix)
    return { id: slug(name) || randomUUID(), name, prefix }
  })
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

/** "Engineering Ops" → "EO", "Research & Development" → "RD"; made unique against `taken`. */
export function defaultPrefix(name, taken = new Set()) {
  const words = name.replace(/&/g, ' ').split(/[^A-Za-z0-9]+/).filter((w) => w && !/^(and|of|the)$/i.test(w))
  let base = words.map((w) => w[0]).join('').toUpperCase().slice(0, 5)
  if (base.length < 2) base = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || 'WS'
  let prefix = base
  for (let i = 2; taken.has(prefix); i++) prefix = `${base.slice(0, 4)}${i}`
  return prefix
}

/**
 * One-off upgrades for records made before task numbers, multiple assignees and
 * workspace prefixes existed. Idempotent; runs once per process. Numbers come from the
 * same atomic counter new cards use, so nothing can get a duplicate number.
 */
let migrated = false
export async function ensureMigrations(store, { force = false } = {}) {
  if (migrated && !force) return
  const workspaces = await store.find('workspaces')
  const taken = new Set(workspaces.map((a) => a.prefix).filter(Boolean))
  for (const a of workspaces) {
    if (a.prefix) continue
    const prefix = defaultPrefix(a.name, taken)
    taken.add(prefix)
    await store.put('workspaces', { ...a, prefix })
  }
  const cards = await store.find('cards')
  const unnumbered = cards
    .filter((c) => !c.number)
    .sort((a, b) => String(a.createdBy?.at || '').localeCompare(String(b.createdBy?.at || '')))
  for (const c of unnumbered) {
    await store.put('cards', normalizeCard({ ...c, number: await store.increment(counterId(c.workspaceId)) }))
  }
  for (const c of cards) {
    if (c.number && 'assigneeEmail' in c) await store.put('cards', normalizeCard(c))
  }
  migrated = true
}

const counterId = (workspaceId) => `task-${workspaceId}`

// --- card shape -------------------------------------------------------------------

/** Every card in the current shape: assignee list, labels, delay fields (old records predate them). */
function normalizeCard(c) {
  const { assigneeEmail, ...rest } = c
  return {
    ...rest,
    assigneeEmails: Array.isArray(c.assigneeEmails) ? c.assigneeEmails : assigneeEmail ? [assigneeEmail] : [],
    labelIds: Array.isArray(c.labelIds) ? c.labelIds : [],
    startDate: c.startDate ?? null,
    estimateHours: typeof c.estimateHours === 'number' ? c.estimateHours : null,
    delayed: Boolean(c.delayed),
    delayReason: c.delayReason || '',
    childProjectId: c.childProjectId || null,
  }
}

export function estimateBuffer(env) {
  const f = Number(env.KANBAN_ESTIMATE_BUFFER)
  return Number.isFinite(f) && f >= 1 && f <= 3 ? f : 1.3
}

/** The guess plus the buffer (+30% by default), to one decimal. */
export function plannedHours(estimate, env) {
  return typeof estimate === 'number' ? Math.round(estimate * estimateBuffer(env) * 10) / 10 : null
}

async function prefixMap(store) {
  return Object.fromEntries((await store.find('workspaces')).map((a) => [a.id, a.prefix || '']))
}

/** A card as the API returns it: current shape, plus its key (ENG-12) and planned hours. */
function presentCard(c, prefixes, env, extra = {}) {
  const card = normalizeCard(c)
  const prefix = prefixes[card.workspaceId]
  return {
    ...card,
    key: card.number && prefix ? `${prefix}-${card.number}` : null,
    plannedHours: plannedHours(card.estimateHours, env),
    ...extra,
  }
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
    estimateBuffer: estimateBuffer(env),
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
  const all = await store.find('workspaces')
  if (all.some((a) => a.id === id)) throw new HttpError(409, 'exists', 'An workspace with that name already exists')
  const prefix = defaultPrefix(name, new Set(all.map((a) => a.prefix)))
  const workspace = await store.put('workspaces', { id, name, prefix, teamsWebhookUrl: '', createdAt: new Date().toISOString() })
  return ok({ workspace: publicWorkspace(workspace, actor) }, 201, {
    action: 'workspace.create',
    summary: `created workspace "${name}" (${prefix})`,
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
  if ('prefix' in body) {
    const prefix = text(body.prefix, 'prefix', { max: 5, required: true }).toUpperCase()
    if (!/^[A-Z][A-Z0-9]{1,4}$/.test(prefix)) {
      throw new HttpError(400, 'invalid_input', 'prefix must be 2–5 letters or digits, starting with a letter')
    }
    const clash = (await store.find('workspaces')).find((a) => a.id !== workspace.id && a.prefix === prefix)
    if (clash) throw new HttpError(409, 'exists', `${clash.name} already uses ${prefix}`)
    next.prefix = prefix
    if (prefix !== workspace.prefix) changes.prefix = { from: workspace.prefix, to: prefix }
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

// --- labels (shared across workspaces) -----------------------------------------------

export const LABEL_COLORS = ['slate', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'violet']

async function validLabelIds(store, value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid_input', 'labelIds must be an array')
  const ids = [...new Set(value.map(String))]
  if (!ids.length) return []
  const known = new Set((await store.find('labels')).map((l) => l.id))
  const bad = ids.filter((id) => !known.has(id))
  if (bad.length) throw new HttpError(400, 'invalid_input', `Unknown labels: ${bad.join(', ')}`)
  return ids
}

function labelColor(value) {
  if (value === undefined) return 'slate'
  if (!LABEL_COLORS.includes(value)) throw new HttpError(400, 'invalid_input', `color must be one of ${LABEL_COLORS.join(', ')}`)
  return value
}

export async function listLabels({ store }) {
  const labels = await store.find('labels')
  return ok({ labels: labels.sort((a, b) => a.name.localeCompare(b.name)), colors: LABEL_COLORS })
}

export async function createLabel({ actor, store, body }) {
  requireEdit(actor)
  const name = text(body.name, 'name', { max: 60, required: true })
  const all = await store.find('labels')
  const clash = all.find((l) => l.name.toLowerCase() === name.toLowerCase())
  if (clash) throw new HttpError(409, 'exists', `The label "${clash.name}" already exists`)
  const label = await store.put('labels', { id: randomUUID(), name, color: labelColor(body.color), createdBy: stamp(actor) })
  return ok({ label }, 201, { action: 'label.create', summary: `created label "${name}"` })
}

export async function updateLabel({ actor, store, params, body }) {
  requireAdmin(actor)
  const label = await store.get('labels', params.id)
  if (!label) throw notFound('Label')
  const next = { ...label }
  if ('name' in body) {
    next.name = text(body.name, 'name', { max: 60, required: true })
    const clash = (await store.find('labels')).find((l) => l.id !== label.id && l.name.toLowerCase() === next.name.toLowerCase())
    if (clash) throw new HttpError(409, 'exists', `The label "${clash.name}" already exists`)
  }
  if ('color' in body) next.color = labelColor(body.color)
  const saved = await store.put('labels', next)
  const changes = {}
  for (const f of ['name', 'color']) if (saved[f] !== label[f]) changes[f] = { from: label[f], to: saved[f] }
  return ok({ label: saved }, 200, { action: 'label.update', summary: `updated label "${saved.name}"`, changes })
}

export async function deleteLabel({ actor, store, params }) {
  requireAdmin(actor)
  const label = await store.get('labels', params.id)
  if (!label) throw notFound('Label')
  // Take it off everything that carries it, so no record points at a missing label.
  const [projects, cards] = await Promise.all([
    store.find('projects', { labelIds: { has: label.id } }),
    store.find('cards', { labelIds: { has: label.id } }),
  ])
  for (const p of projects) await store.put('projects', { ...p, labelIds: p.labelIds.filter((id) => id !== label.id) })
  for (const c of cards) await store.put('cards', { ...c, labelIds: c.labelIds.filter((id) => id !== label.id) })
  await store.remove('labels', label)
  return ok({ deleted: true, removedFrom: { projects: projects.length, cards: cards.length } }, 200, {
    action: 'label.delete',
    summary: `deleted label "${label.name}" (was on ${projects.length} project${projects.length === 1 ? '' : 's'} and ${cards.length} card${cards.length === 1 ? '' : 's'})`,
  })
}

// --- projects -------------------------------------------------------------------

/** Project due date (#12): a date, or `ongoing` for no end date. Setting one clears the other. */
function projectDue(body, current = { dueDate: null, ongoing: false }) {
  let { dueDate, ongoing } = current
  if ('dueDate' in body) dueDate = optionalDate(body.dueDate, 'dueDate')
  if ('ongoing' in body) ongoing = Boolean(body.ongoing)
  if ('ongoing' in body && ongoing) dueDate = null
  else if ('dueDate' in body && dueDate) ongoing = false
  return { dueDate: dueDate ?? null, ongoing: Boolean(ongoing) }
}

function presentProject(p) {
  return { ...p, dueDate: p.dueDate ?? null, ongoing: Boolean(p.ongoing), labelIds: p.labelIds || [], parentCardId: p.parentCardId || null }
}

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
        return { ...presentProject(p), cardCount: mine.length, openCount: mine.filter((c) => c.column !== 'done').length }
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
}

export async function createProject({ actor, store, params, body }) {
  requireProjectEdit(actor)
  const workspace = await loadWorkspace(store, actor, params.id)
  const project = await store.put('projects', {
    id: randomUUID(),
    workspaceId: workspace.id,
    name: text(body.name, 'name', { max: 120, required: true }),
    description: text(body.description, 'description', { max: 2000 }),
    repoUrl: optionalUrl(body.repoUrl, 'repoUrl'),
    ...projectDue(body),
    labelIds: (await validLabelIds(store, body.labelIds)) ?? [],
    archived: false,
    createdBy: stamp(actor),
  })
  return ok({ project: presentProject(project) }, 201, {
    action: 'project.create',
    summary: `created project "${project.name}"`,
    workspaceId: workspace.id,
    projectId: project.id,
  })
}

/** Everything the board screen needs in one round trip. */
export async function getProject({ actor, store, env, params }) {
  const project = await loadProject(store, actor, params.id)
  const [workspace, cards, members, parent] = await Promise.all([
    store.get('workspaces', project.workspaceId),
    store.find('cards', { projectId: project.id }),
    workspacePeople(store, env, project.workspaceId),
    project.parentCardId ? store.get('cards', project.parentCardId) : null,
  ])
  const prefixes = { [workspace.id]: workspace.prefix }
  return ok({
    project: presentProject(project),
    workspace: publicWorkspace(workspace, actor),
    columns: COLUMNS,
    cards: cards.sort((a, b) => a.order - b.order).map((c) => presentCard(c, prefixes, env)),
    members,
    parentCard:
      parent && canAccessWorkspace(actor, parent.workspaceId)
        ? { id: parent.id, projectId: parent.projectId, title: parent.title, key: presentCard(parent, await prefixMap(store), env).key }
        : null,
  })
}

export async function updateProject({ actor, store, params, body }) {
  requireProjectEdit(actor)
  const project = presentProject(await loadProject(store, actor, params.id))
  const next = { ...project, ...projectDue(body, project) }
  if ('name' in body) next.name = text(body.name, 'name', { max: 120, required: true })
  if ('description' in body) next.description = text(body.description, 'description', { max: 2000 })
  if ('repoUrl' in body) next.repoUrl = optionalUrl(body.repoUrl, 'repoUrl')
  if ('archived' in body) next.archived = Boolean(body.archived)
  if ('labelIds' in body) next.labelIds = await validLabelIds(store, body.labelIds)
  const changes = {}
  for (const f of ['name', 'description', 'repoUrl', 'archived', 'dueDate', 'ongoing']) {
    if (next[f] !== project[f]) changes[f] = { from: short(project[f]), to: short(next[f]) }
  }
  if (JSON.stringify(next.labelIds) !== JSON.stringify(project.labelIds)) changes.labelIds = { from: project.labelIds, to: next.labelIds }
  next.updatedBy = stamp(actor)
  const saved = await store.put('projects', next)
  return ok({ project: presentProject(saved) }, 200, {
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
  // A task that was turned into this project goes back to being a plain task.
  if (project.parentCardId) {
    const parent = await store.get('cards', project.parentCardId)
    if (parent) await store.put('cards', { ...parent, childProjectId: null })
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

export async function listCards({ actor, store, env, params, query }) {
  const project = await loadProject(store, actor, params.id)
  const where = { projectId: project.id }
  if (query.column) where.column = column(query.column)
  let cards = (await store.find('cards', where)).map(normalizeCard)
  if (query.assignee) cards = cards.filter((c) => c.assigneeEmails.includes(String(query.assignee).toLowerCase()))
  const prefixes = await prefixMap(store)
  return ok({ cards: cards.sort((a, b) => a.order - b.order).map((c) => presentCard(c, prefixes, env)) })
}

/** Assignees (#4): a list of emails, each of whom must be able to see the workspace. Accepts the old single `assigneeEmail` too. */
async function resolveAssignees(store, env, workspaceId, body) {
  let raw
  if ('assigneeEmails' in body) raw = body.assigneeEmails
  else if ('assigneeEmail' in body) raw = body.assigneeEmail ? [body.assigneeEmail] : []
  else return undefined
  if (raw === null) raw = []
  if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_input', 'assigneeEmails must be an array')
  if (raw.length > 10) throw new HttpError(400, 'invalid_input', 'A task can have at most 10 assignees')
  const people = await workspacePeople(store, env, workspaceId)
  const out = []
  for (const value of raw) {
    const addr = email(value, 'assigneeEmails')
    const person = people.find((p) => p.email === addr)
    if (!person) throw new HttpError(400, 'invalid_input', `${addr} does not have access to this workspace`)
    if (!out.some((p) => p.email === addr)) out.push(person)
  }
  return out
}

function estimate(value) {
  if (value === null || value === '' || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new HttpError(400, 'invalid_input', 'estimateHours must be between 0 and 1000')
  return Math.round(n * 100) / 100
}

/** Delay (#3): marking a task delayed needs a reason; un-marking clears it. */
function applyDelay(next, body, actor) {
  if (!('delayed' in body) && !('delayReason' in body)) return
  const delayed = 'delayed' in body ? Boolean(body.delayed) : next.delayed
  if (!delayed) {
    Object.assign(next, { delayed: false, delayReason: '', delayedBy: null })
    return
  }
  const reason = text('delayReason' in body ? body.delayReason : next.delayReason, 'delayReason', { max: 500 })
  if (!reason) throw new HttpError(400, 'invalid_input', 'Say why the task is delayed (delayReason)')
  const wasDelayed = next.delayed
  Object.assign(next, { delayed: true, delayReason: reason, ...(wasDelayed ? {} : { delayedBy: stamp(actor) }) })
}

function checkDates(card) {
  if (card.startDate && card.dueDate && card.startDate > card.dueDate) {
    throw new HttpError(400, 'invalid_input', 'startDate must be on or before dueDate')
  }
}

async function notifyNewAssignees({ store, env, logger, card, before, after, actor }) {
  const added = after.filter((p) => !before.includes(p.email))
  if (!added.length) return
  const [workspace, project] = await Promise.all([store.get('workspaces', card.workspaceId), store.get('projects', card.projectId)])
  for (const assignee of added) await notifyAssigned({ env, logger, workspace, project, card, assignee, actor })
}

/** Builds and stores a new card; used by create, duplicate and convert. */
async function insertCard(store, actor, project, fields) {
  const now = stamp(actor)
  const card = normalizeCard({
    id: randomUUID(),
    projectId: project.id,
    workspaceId: project.workspaceId,
    description: '',
    column: 'backlog',
    dueDate: null,
    checklist: [],
    commentCount: 0,
    ...fields,
    number: await store.increment(counterId(project.workspaceId)),
    createdBy: now,
    updatedBy: now,
  })
  if (typeof card.order !== 'number') card.order = await nextOrder(store, project.id, card.column)
  checkDates(card)
  return store.put('cards', card)
}

export async function createCard({ actor, store, env, logger, params, body }) {
  requireEdit(actor)
  const project = await loadProject(store, actor, params.id)
  const assignees = (await resolveAssignees(store, env, project.workspaceId, body)) ?? []
  const fields = {
    title: text(body.title, 'title', { max: 200, required: true }),
    description: text(body.description, 'description', { max: 10000 }),
    column: body.column === undefined ? 'backlog' : column(body.column),
    assigneeEmails: assignees.map((p) => p.email),
    startDate: optionalDate(body.startDate, 'startDate'),
    dueDate: optionalDate(body.dueDate, 'dueDate'),
    estimateHours: estimate(body.estimateHours),
    labelIds: (await validLabelIds(store, body.labelIds)) ?? [],
    checklist: body.checklist === undefined ? [] : checklist(body.checklist),
    ...(typeof body.order === 'number' && Number.isFinite(body.order) ? { order: body.order } : {}),
  }
  applyDelay(fields, body, actor)
  const card = await insertCard(store, actor, project, fields)
  await notifyNewAssignees({ store, env, logger, card, before: [], after: assignees, actor })
  const shown = presentCard(card, await prefixMap(store), env)
  return ok({ card: shown }, 201, {
    action: 'card.create',
    summary: `created ${shown.key} "${card.title}" in ${project.name}`,
    workspaceId: card.workspaceId,
    projectId: card.projectId,
    cardId: card.id,
  })
}

export async function getCard({ actor, store, env, params }) {
  const card = await loadCard(store, actor, params.id)
  const [comments, child] = await Promise.all([
    store.find('comments', { cardId: card.id }),
    card.childProjectId ? store.get('projects', card.childProjectId) : null,
  ])
  let childProject = null
  if (child) {
    const childCards = await store.find('cards', { projectId: child.id })
    childProject = {
      id: child.id,
      name: child.name,
      cardCount: childCards.length,
      doneCount: childCards.filter((c) => c.column === 'done').length,
    }
  }
  return ok({
    card: presentCard(card, await prefixMap(store), env),
    comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    childProject,
  })
}

const checklistSummary = (items) => `${items.filter((i) => i.done).length}/${items.length} done`

function listDiff(before = [], after = []) {
  const added = after.filter((x) => !before.includes(x))
  const removed = before.filter((x) => !after.includes(x))
  return added.length || removed.length ? { from: before, to: after, ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) } : null
}

/** Old → new for every card field a PATCH touched (order is noise from dragging, so it's left out). */
function cardChanges(before, after) {
  const changes = {}
  for (const f of ['title', 'column', 'startDate', 'dueDate', 'estimateHours', 'delayed', 'delayReason']) {
    if ((before[f] ?? null) !== (after[f] ?? null)) changes[f] = { from: before[f] ?? null, to: after[f] ?? null }
  }
  const assignees = listDiff(before.assigneeEmails, after.assigneeEmails)
  if (assignees) changes.assigneeEmails = assignees
  const labels = listDiff(before.labelIds, after.labelIds)
  if (labels) changes.labelIds = labels
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
  const name = `${card.key ? `${card.key} ` : ''}"${card.title}"`
  if (changes.column) return `moved ${name} from ${changes.column.from} to ${changes.column.to}`
  if (changes.delayed) return changes.delayed.to ? `marked ${name} delayed: ${card.delayReason}` : `cleared the delay on ${name}`
  if (changes.assigneeEmails) {
    return card.assigneeEmails.length ? `assigned ${name} to ${card.assigneeEmails.join(', ')}` : `unassigned ${name}`
  }
  if (changes.dueDate || changes.startDate) {
    return `rescheduled ${name}${card.startDate ? ` ${card.startDate} →` : ' to'} ${card.dueDate || 'no date'}`
  }
  const fields = Object.keys(changes)
  if (!fields.length) return `reordered ${name}`
  return `updated ${fields.join(', ')} on ${name}`
}

export async function updateCard({ actor, store, env, logger, params, body }) {
  requireEdit(actor)
  const card = normalizeCard(await loadCard(store, actor, params.id))
  const next = { ...card }
  if ('title' in body) next.title = text(body.title, 'title', { max: 200, required: true })
  if ('description' in body) next.description = text(body.description, 'description', { max: 10000 })
  if ('startDate' in body) next.startDate = optionalDate(body.startDate, 'startDate')
  if ('dueDate' in body) next.dueDate = optionalDate(body.dueDate, 'dueDate')
  if ('estimateHours' in body) next.estimateHours = estimate(body.estimateHours)
  if ('checklist' in body) next.checklist = checklist(body.checklist)
  if ('labelIds' in body) next.labelIds = await validLabelIds(store, body.labelIds)
  applyDelay(next, body, actor)
  checkDates(next)

  const assignees = await resolveAssignees(store, env, card.workspaceId, body)
  if (assignees) next.assigneeEmails = assignees.map((p) => p.email)

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
  if (assignees) await notifyNewAssignees({ store, env, logger, card: saved, before: card.assigneeEmails, after: assignees, actor })
  const shown = presentCard(saved, await prefixMap(store), env)
  return ok({ card: shown }, 200, {
    action: changes.column ? 'card.move' : 'card.update',
    summary: describeCardChange(shown, changes),
    workspaceId: saved.workspaceId,
    projectId: saved.projectId,
    cardId: saved.id,
    changes,
  })
}

/** #1: a copy of everything but comments, history and the delay flag, placed right under the original. */
export async function duplicateCard({ actor, store, env, params }) {
  requireEdit(actor)
  const card = normalizeCard(await loadCard(store, actor, params.id))
  const project = await store.get('projects', card.projectId)
  const lane = (await store.find('cards', { projectId: card.projectId, column: card.column })).sort((a, b) => a.order - b.order)
  const below = lane[lane.findIndex((c) => c.id === card.id) + 1]
  const copy = await insertCard(store, actor, project, {
    title: `Copy of ${card.title}`.slice(0, 200),
    description: card.description,
    column: card.column,
    order: below ? (card.order + below.order) / 2 : card.order + ORDER_STEP,
    assigneeEmails: card.assigneeEmails,
    labelIds: card.labelIds,
    startDate: card.startDate,
    dueDate: card.dueDate,
    estimateHours: card.estimateHours,
    checklist: card.checklist.map((i) => ({ id: randomUUID(), text: i.text, done: false })),
  })
  const prefixes = await prefixMap(store)
  const shown = presentCard(copy, prefixes, env)
  const source = presentCard(card, prefixes, env)
  return ok({ card: shown }, 201, {
    action: 'card.duplicate',
    summary: `duplicated ${source.key} as ${shown.key} "${shown.title}"`,
    workspaceId: copy.workspaceId,
    projectId: copy.projectId,
    cardId: copy.id,
    changes: { from: source.key },
  })
}

/**
 * #9: turn a task whose scope has grown into a project. Each checklist item becomes a
 * task (ticked ones straight to Done); the original stays open as the parent.
 */
export async function convertCard({ actor, store, env, params, body }) {
  requireProjectEdit(actor)
  const card = normalizeCard(await loadCard(store, actor, params.id))
  if (card.childProjectId) throw new HttpError(409, 'already_converted', 'This task is already a project')
  const project = await store.put('projects', {
    id: randomUUID(),
    workspaceId: card.workspaceId,
    name: text(body.name ?? card.title, 'name', { max: 120, required: true }),
    description: short(card.description, 2000) || '',
    repoUrl: '',
    dueDate: card.dueDate,
    ongoing: false,
    labelIds: card.labelIds,
    parentCardId: card.id,
    archived: false,
    createdBy: stamp(actor),
  })
  const created = []
  for (const item of card.checklist) {
    created.push(
      await insertCard(store, actor, project, {
        title: item.text.slice(0, 200),
        column: item.done ? 'done' : 'backlog',
        assigneeEmails: card.assigneeEmails,
        labelIds: card.labelIds,
      }),
    )
  }
  const parent = await store.put('cards', { ...card, checklist: [], childProjectId: project.id, updatedBy: stamp(actor) })
  const prefixes = await prefixMap(store)
  const shown = presentCard(parent, prefixes, env)
  return ok(
    { project: presentProject(project), card: shown, cards: created.map((c) => presentCard(c, prefixes, env)) },
    201,
    {
      action: 'card.convert',
      summary: `turned ${shown.key} "${card.title}" into project "${project.name}" with ${created.length} task${created.length === 1 ? '' : 's'}`,
      workspaceId: card.workspaceId,
      projectId: card.projectId,
      cardId: card.id,
      changes: { projectId: project.id, tasks: created.map((c) => c.title), checklist: { from: checklistSummary(card.checklist), to: 'moved to project' } },
    },
  )
}

export async function deleteCard({ actor, store, params }) {
  requireEdit(actor)
  const card = normalizeCard(await loadCard(store, actor, params.id))
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
    changes: {
      snapshot: {
        number: card.number,
        title: card.title,
        column: card.column,
        assigneeEmails: card.assigneeEmails,
        dueDate: card.dueDate,
        estimateHours: card.estimateHours,
        description: short(card.description),
      },
    },
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

// --- search, cross-project queries, calendar --------------------------------------

async function visibleWorkspaceIds(store, actor, only) {
  let ids = (await store.find('workspaces')).filter((a) => canAccessWorkspace(actor, a.id)).map((a) => a.id)
  if (only) ids = ids.filter((id) => id === only)
  return ids
}

async function withProjectNames(store, cards) {
  const projectIds = [...new Set(cards.map((c) => c.projectId))]
  const projects = projectIds.length ? await store.find('projects', { id: { in: projectIds } }) : []
  const nameOf = Object.fromEntries(projects.map((p) => [p.id, p.name]))
  return (c) => ({ projectName: nameOf[c.projectId] || '' })
}

export async function search({ actor, store, env, query }) {
  const q = text(query.q, 'q', { max: 100, required: true })
  if (q.length < 2) throw new HttpError(400, 'invalid_input', 'Search for at least 2 characters')
  const workspaceIds = await visibleWorkspaceIds(store, actor, query.workspaceId)
  if (!workspaceIds.length) return ok({ cards: [] })

  const prefixes = await prefixMap(store)
  // "ENG-12" jumps straight to that task.
  const byKey = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d+)$/.exec(q)
  let exact = []
  if (byKey) {
    const workspaceId = workspaceIds.find((id) => prefixes[id] === byKey[1].toUpperCase())
    if (workspaceId) exact = await store.find('cards', { workspaceId, number: Number(byKey[2]) }, { limit: 1 })
  }
  const found = await store.find(
    'cards',
    { workspaceId: { in: workspaceIds } },
    { contains: { fields: ['title', 'description'], text: q }, limit: 50 },
  )
  const cards = [...exact, ...found.filter((c) => !exact.some((e) => e.id === c.id))]
  const names = await withProjectNames(store, cards)
  return ok({ cards: cards.map((c) => presentCard(c, prefixes, env, names(c))) })
}

/** Split each task's planned hours evenly across its assignees; overall counts each task once. Done tasks don't count. */
function hourTotals(cards) {
  const byPerson = {}
  let overall = 0
  let unassigned = 0
  for (const c of cards) {
    if (c.column === 'done' || !c.plannedHours) continue
    overall += c.plannedHours
    if (!c.assigneeEmails.length) unassigned += c.plannedHours
    for (const e of c.assigneeEmails) byPerson[e] = (byPerson[e] || 0) + c.plannedHours / c.assigneeEmails.length
  }
  const round = (n) => Math.round(n * 10) / 10
  return {
    overall: round(overall),
    unassigned: round(unassigned),
    byPerson: Object.fromEntries(Object.entries(byPerson).map(([e, h]) => [e, round(h)])),
  }
}

/** #10: tasks across projects, filtered by label / workspace / person — for billing, the CRM and reports. */
export async function queryCards({ actor, store, env, query }) {
  const workspaceIds = await visibleWorkspaceIds(store, actor, query.workspaceId)
  if (!workspaceIds.length) return ok({ cards: [], totals: hourTotals([]) })
  const where = { workspaceId: { in: workspaceIds } }
  if (query.labelId) where.labelIds = { has: String(query.labelId) }
  if (query.assignee) where.assigneeEmails = { has: String(query.assignee).toLowerCase() }
  if (query.column) where.column = column(query.column)
  const raw = await store.find('cards', where, { limit: 500 })
  const prefixes = await prefixMap(store)
  const names = await withProjectNames(store, raw)
  const cards = raw.map((c) => presentCard(c, prefixes, env, names(c)))
  return ok({ cards, totals: hourTotals(cards) })
}

const MAX_RANGE_DAYS = 120

/**
 * #11: every task that overlaps [from, to] (start→due, or just due), in the workspaces
 * the caller can see, plus undated open tasks for the "unscheduled" tray and hour totals.
 */
export async function calendar({ actor, store, env, query }) {
  const from = optionalDate(query.from, 'from')
  const to = optionalDate(query.to, 'to')
  if (!from || !to || from > to) throw new HttpError(400, 'invalid_input', 'from and to are required (YYYY-MM-DD), from ≤ to')
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) {
    throw new HttpError(400, 'invalid_input', `Ask for at most ${MAX_RANGE_DAYS} days at a time`)
  }
  const workspaceIds = await visibleWorkspaceIds(store, actor, query.workspaceId)
  const people = []
  for (const id of workspaceIds) for (const p of await workspacePeople(store, env, id)) if (!people.some((x) => x.email === p.email)) people.push(p)
  if (!workspaceIds.length) return ok({ cards: [], unscheduled: [], totals: hourTotals([]), people })

  const scope = { workspaceId: { in: workspaceIds } }
  if (query.labelId) scope.labelIds = { has: String(query.labelId) }
  if (query.assignee) scope.assigneeEmails = { has: String(query.assignee).toLowerCase() }
  const [dated, undated] = await Promise.all([
    store.find('cards', { ...scope, dueDate: { gte: from } }, { limit: 1000 }),
    store.find('cards', { ...scope, dueDate: null }, { limit: 200 }),
  ])
  const inRange = dated.filter((c) => (c.startDate || c.dueDate) <= to)
  const prefixes = await prefixMap(store)
  const names = await withProjectNames(store, [...inRange, ...undated])
  const cards = inRange.map((c) => presentCard(c, prefixes, env, names(c)))
  return ok({
    from,
    to,
    cards,
    unscheduled: undated.filter((c) => c.column !== 'done').map((c) => presentCard(c, prefixes, env, names(c))),
    totals: hourTotals(cards),
    people: people.sort((a, b) => a.name.localeCompare(b.name)),
  })
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
