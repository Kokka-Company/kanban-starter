import { createHash, randomBytes } from 'node:crypto'
import { readClientPrincipal, headerValue } from './principal.mjs'
import { readSession } from './session.mjs'

/**
 * Who is calling, and what they may do. Two ways in:
 *
 *  - A signed-in person: SWA's built-in Microsoft login puts their email in
 *    x-ms-client-principal — or, when SWA drops that header (it does, intermittently),
 *    the signed pass from session.mjs that an earlier request with the header earned. Any Microsoft account can sign in to SWA's built-in
 *    provider, so being signed in is not enough — the email must be in `members`
 *    (or in KANBAN_ADMIN_EMAILS, the bootstrap admins).
 *    Roles: admin (everything), member (edit cards in their workspaces), viewer
 *    (read-only). If KANBAN_EDIT_DOMAINS is set (e.g. "yourcompany.com"), only emails
 *    on those domains can ever edit — anyone else is a viewer whatever their record
 *    says. Unset means any member can edit.
 *  - An API key (for Claude / scripts): `X-Api-Key: kk_…` or `Authorization: Bearer kk_…`.
 *
 * The two never share a door: people use /api/*, keys use /api/v1/*, and each door
 * refuses the other kind of caller. `channel` says which door a request used.
 *    Each key has a scope (read | cards | admin), an optional workspace list and an
 *    optional expiry. Only the SHA-256 of a key is stored.
 *
 * @typedef {{
 *   type: 'user' | 'key',
 *   email: string,
 *   name: string,
 *   role: 'admin' | 'member' | 'viewer',
 *   isAdmin: boolean,
 *   canEdit: boolean,
 *   allWorkspaces: boolean,
 *   workspaceIds: string[],
 *   label: string,
 *   keyId?: string,
 * }} Actor
 */

export const KEY_PREFIX = 'kk_'
export const KEY_SCOPES = ['read', 'cards', 'admin']

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex')
}

export function generateKey() {
  return KEY_PREFIX + randomBytes(32).toString('base64url')
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

export function bootstrapAdmins(env) {
  return list(env.KANBAN_ADMIN_EMAILS)
}

/** Domains whose people may edit. Empty means no domain restriction. */
export function editDomains(env) {
  return list(env.KANBAN_EDIT_DOMAINS)
}

/** True when this email's domain is allowed to edit anything at all. */
export function canEmailEdit(email, env) {
  const domains = editDomains(env)
  if (!domains.length) return true
  const domain = String(email).toLowerCase().split('@')[1] || ''
  return domains.includes(domain)
}

/** The role a member record actually gets, after the domain rule. */
export function effectiveRole(member, env) {
  if (bootstrapAdmins(env).includes(member.email)) return 'admin'
  if (!canEmailEdit(member.email, env)) return 'viewer'
  return member.role === 'admin' || member.role === 'member' ? member.role : 'viewer'
}

function presentedKey(headers) {
  const direct = headerValue(headers, 'x-api-key').trim()
  if (direct) return direct
  const auth = headerValue(headers, 'authorization').trim()
  const m = /^Bearer\s+(\S+)$/i.exec(auth)
  return m && m[1].startsWith(KEY_PREFIX) ? m[1] : ''
}

/**
 * @returns {Promise<
 *   | { ok: true, actor: Actor }
 *   | { ok: false, status: 401, error: string }
 *   | { ok: false, status: 403, error: 'not_a_member', email: string }
 * >}
 */
export async function authorize(headers, store, env, { devUser = '', channel = 'session' } = {}) {
  const key = presentedKey(headers)
  if (channel === 'key') {
    if (!key) return { ok: false, status: 401, error: 'api_key_required' }
    return authorizeKey(key, store)
  }
  if (key) return { ok: false, status: 401, error: 'use_api_v1' }

  const principal = readClientPrincipal(headers)
  const session = principal?.email ? null : readSession(headers, env)
  const email = principal?.email || session?.email || devUser.toLowerCase()
  const via = principal?.email ? 'principal' : session ? 'session' : 'dev'
  if (!email) return { ok: false, status: 401, error: 'unauthenticated' }

  let member = await store.get('members', email)
  if (!member && bootstrapAdmins(env).includes(email)) {
    // First sign-in of a bootstrap admin: give them a member record so they show up
    // in assignee lists like everyone else.
    member = await store.put('members', {
      id: email,
      email,
      name: email.split('@')[0],
      role: 'admin',
      workspaceIds: [],
      createdAt: new Date().toISOString(),
    })
  }
  if (!member) return { ok: false, status: 403, error: 'not_a_member', email }

  const role = effectiveRole(member, env)
  return {
    ok: true,
    actor: {
      type: 'user',
      email,
      name: member.name || email,
      role,
      isAdmin: role === 'admin',
      canEdit: role !== 'viewer',
      allWorkspaces: role === 'admin',
      workspaceIds: member.workspaceIds || [],
      label: member.name || email,
    },
    via,
    session: readSession(headers, env),
  }
}

const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000

async function authorizeKey(key, store) {
  const [record] = await store.find('apiKeys', { sha256Hash: hashKey(key) }, { limit: 1 })
  if (!record || record.revoked) return { ok: false, status: 401, error: 'invalid_api_key' }
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    return { ok: false, status: 401, error: 'api_key_expired' }
  }

  // Hourly is plenty for "is this key still used?" and saves a write per call.
  const last = Date.parse(record.lastUsedAt || '') || 0
  if (Date.now() - last > LAST_USED_RESOLUTION_MS) {
    await store.put('apiKeys', { ...record, lastUsedAt: new Date().toISOString() })
  }

  // Keys made before scopes existed had full rights; keep that rather than break them.
  const scope = KEY_SCOPES.includes(record.scope) ? record.scope : 'admin'
  const workspaceIds = scope === 'admin' ? [] : record.workspaceIds || []
  return {
    ok: true,
    actor: {
      type: 'key',
      email: '',
      name: record.name,
      role: scope === 'admin' ? 'admin' : scope === 'cards' ? 'member' : 'viewer',
      isAdmin: scope === 'admin',
      canEdit: scope !== 'read',
      allWorkspaces: workspaceIds.length === 0,
      workspaceIds,
      label: `${record.name} (AI key)`,
      keyId: record.id,
    },
  }
}

export function canAccessWorkspace(actor, workspaceId) {
  return actor.allWorkspaces || actor.workspaceIds.includes(workspaceId)
}

/** Stamp recorded on anything an actor creates or changes. */
export function stamp(actor) {
  return { email: actor.email, label: actor.label, at: new Date().toISOString(), ...(actor.keyId ? { keyId: actor.keyId } : {}) }
}
