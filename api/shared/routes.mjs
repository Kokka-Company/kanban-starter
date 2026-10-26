import * as h from './handlers.mjs'
import { authorize } from './auth.mjs'
import { getStore } from './store.mjs'
import { normalizeLogger } from './logger.mjs'
import { recordActivity } from './activity.mjs'
import { issueSession, needsRefresh, sessionCookieHeader } from './session.mjs'

/**
 * The whole API in one table. Paths use Azure Functions route syntax ({param}) and
 * are relative to /api. Both the deployed Functions (src/functions/kanban.mjs) and
 * the local dev server register exactly this list.
 */
export const ROUTES = [
  ['GET', 'me', h.getMe],

  ['GET', 'workspaces', h.listWorkspaces],
  ['POST', 'workspaces', h.createWorkspace],
  ['PATCH', 'workspaces/{id}', h.updateWorkspace],
  ['DELETE', 'workspaces/{id}', h.deleteWorkspace],
  ['GET', 'workspaces/{id}/members', h.listWorkspaceMembers],
  ['GET', 'workspaces/{id}/projects', h.listProjects],
  ['POST', 'workspaces/{id}/projects', h.createProject],

  ['GET', 'labels', h.listLabels],
  ['POST', 'labels', h.createLabel],
  ['PATCH', 'labels/{id}', h.updateLabel],
  ['DELETE', 'labels/{id}', h.deleteLabel],

  ['GET', 'projects/{id}', h.getProject],
  ['PATCH', 'projects/{id}', h.updateProject],
  ['DELETE', 'projects/{id}', h.deleteProject],
  ['GET', 'projects/{id}/cards', h.listCards],
  ['POST', 'projects/{id}/cards', h.createCard],

  ['GET', 'cards/{id}', h.getCard],
  ['PATCH', 'cards/{id}', h.updateCard],
  ['DELETE', 'cards/{id}', h.deleteCard],
  ['POST', 'cards/{id}/duplicate', h.duplicateCard],
  ['POST', 'cards/{id}/convert', h.convertCard],
  ['GET', 'cards', h.queryCards],
  ['GET', 'cards/{id}/comments', h.listComments],
  ['POST', 'cards/{id}/comments', h.createComment],
  ['DELETE', 'comments/{id}', h.deleteComment],

  ['GET', 'search', h.search],
  ['GET', 'calendar', h.calendar],

  ['GET', 'members', h.listMembers],
  ['POST', 'members', h.createMember],
  ['PATCH', 'members/{email}', h.updateMember],
  ['DELETE', 'members/{email}', h.deleteMember],

  ['GET', 'keys', h.listKeys],
  ['POST', 'keys', h.createKey],
  ['DELETE', 'keys/{id}', h.revokeKey],

  ['GET', 'activity', h.listActivity],
  ['GET', 'cards/{id}/activity', h.cardActivity],
].map(([method, path, handler]) => ({ method, path, handler }))

/**
 * Run one request through auth, body parsing and the handler. Transport-neutral:
 *
 * @param {{ method: string, path: string, handler: Function }} route
 * @param {{ params: object, query: object, headers: any, rawBody: string, env: object, logger?: any, devUser?: string, channel?: 'session' | 'key' }} req
 * @returns {Promise<{ status: number, body: any, setCookie?: string }>}
 */
export async function runRoute(route, { params, query, headers, rawBody, env, logger, devUser, channel = 'session' }) {
  const log = normalizeLogger(logger)
  const routeLabel = `${route.method} /api/${channel === 'key' ? 'v1/' : ''}${route.path.replace(/\{(\w+)\}/g, (_, n) => params?.[n] ?? n)}`
  let actor = null
  try {
    const store = await getStore(env)
    await h.ensureSeed(store, env)
    await h.ensureMigrations(store)

    const auth = await authorize(headers, store, env, { devUser, channel })
    if (!auth.ok) {
      return { status: auth.status, body: { ok: false, error: auth.error, ...(auth.email ? { email: auth.email } : {}) } }
    }

    let body = {}
    if (route.method === 'POST' || route.method === 'PATCH') {
      // Requiring JSON also means a cross-site form can't post here with the login cookie.
      const type = typeof headers?.get === 'function' ? headers.get('content-type') : headers?.['content-type']
      if (!String(type || '').toLowerCase().startsWith('application/json')) {
        return { status: 415, body: { ok: false, error: 'json_required', message: 'Send Content-Type: application/json' } }
      }
      try {
        body = JSON.parse(rawBody || '{}')
      } catch {
        return { status: 400, body: { ok: false, error: 'invalid_json' } }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 400, body: { ok: false, error: 'invalid_json' } }
      }
    }

    actor = auth.actor
    const result = await route.handler({ actor, params, query, body, store, env, logger: log })
    if (route.method !== 'GET') {
      await recordActivity(store, actor, { ...(result.audit || { action: route.path, summary: `${route.method} /api/${route.path}` }), route: routeLabel }, log)
    }
    // Seen with a real principal: (re)issue the signed pass that covers for SWA when it
    // drops the header on a later request.
    let setCookie
    if (auth.via === 'principal' && needsRefresh(auth.session)) {
      const token = issueSession(actor.email, env)
      if (token) setCookie = sessionCookieHeader(token)
    }
    return { status: result.status, body: { ok: true, ...result.body }, ...(setCookie ? { setCookie } : {}) }
  } catch (err) {
    if (err instanceof h.HttpError) {
      // Refused writes by someone we know are security-relevant: log those too.
      if (actor && err.status === 403 && route.method !== 'GET') {
        const store = await getStore(env)
        await recordActivity(store, actor, { action: 'denied', summary: `was refused: ${err.message}`, route: routeLabel, status: 403 }, log)
      }
      return { status: err.status, body: { ok: false, error: err.code, message: err.message } }
    }
    log.error(`[kanban] ${route.method} /api/${route.path} failed:`, err)
    return { status: 500, body: { ok: false, error: 'server_error' } }
  }
}
